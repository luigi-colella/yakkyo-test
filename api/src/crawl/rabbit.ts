import { assertQueueTopology, EXCHANGES, QUEUES } from '@crawler/shared';
import type { CrawlMessage } from '@crawler/shared';
import amqp from 'amqplib';
import type { Options } from 'amqplib';

export interface CrawlPublisher {
  /** Resolves once the broker has confirmed the message is stored. */
  publish(message: CrawlMessage): Promise<void>;
}

/** The subset of an amqplib confirm channel used to publish. */
export interface ConfirmPublishChannel {
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Options.Publish,
    callback: (error: unknown) => void,
  ): boolean;
}

export const PUBLISH_CONFIRM_TIMEOUT_MS = 5_000;

export class RabbitPublisher implements CrawlPublisher {
  constructor(
    private readonly channel: ConfirmPublishChannel,
    private readonly confirmTimeoutMs = PUBLISH_CONFIRM_TIMEOUT_MS,
  ) {}

  publish(message: CrawlMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // An unconfirmed message must not hang the HTTP request that published it.
      const timer = setTimeout(
        () => reject(new Error('RabbitMQ publish confirm timed out')),
        this.confirmTimeoutMs,
      );
      const fail = (error: unknown, fallbackMessage: string) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(fallbackMessage));
      };

      try {
        // amqplib calls back with `null` on ack and with an error on nack.
        this.channel.publish(
          EXCHANGES.crawl,
          QUEUES.requests,
          Buffer.from(JSON.stringify(message)),
          { persistent: true, contentType: 'application/json', messageId: message.uid },
          (error) => {
            if (error) return fail(error, 'RabbitMQ rejected the message');
            clearTimeout(timer);
            resolve();
          },
        );
      } catch (error: unknown) {
        // Thrown synchronously, e.g. when the channel is already closed.
        fail(error, 'RabbitMQ publish failed');
      }
    });
  }
}

export interface RabbitConnection {
  publisher: CrawlPublisher;
  close(): Promise<void>;
}

/**
 * Opens a confirm channel, declares the topology and returns a publisher.
 * `onUnexpectedClose` fires once if the connection or channel goes away
 * without `close()` having been called.
 */
export async function connectRabbit(
  url: string,
  onUnexpectedClose: (error: Error) => void,
): Promise<RabbitConnection> {
  const connection = await amqp.connect(url);
  let closing = false;
  let notified = false;
  const handleClose = (reason: string) => {
    if (closing || notified) return;
    notified = true;
    onUnexpectedClose(new Error(reason));
  };

  try {
    const channel = await connection.createConfirmChannel();
    await assertQueueTopology(channel);
    // 'error' is always followed by 'close'; without a listener it would crash the process.
    connection.on('error', () => undefined);
    channel.on('error', () => undefined);
    connection.on('close', () => handleClose('RabbitMQ connection closed'));
    channel.on('close', () => handleClose('RabbitMQ channel closed'));

    return {
      publisher: new RabbitPublisher(channel),
      async close() {
        closing = true;
        await connection.close();
      },
    };
  } catch (error: unknown) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}

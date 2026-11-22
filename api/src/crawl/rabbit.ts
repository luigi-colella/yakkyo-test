import { assertQueueTopology, EXCHANGES, publishConfirmed, QUEUES } from '@crawler/shared';
import type { ConfirmPublishChannel, CrawlMessage } from '@crawler/shared';
import amqp from 'amqplib';

export interface CrawlPublisher {
  /** Resolves once the broker has confirmed the message is stored. */
  publish(message: CrawlMessage): Promise<void>;
}

export class RabbitPublisher implements CrawlPublisher {
  constructor(
    private readonly channel: ConfirmPublishChannel,
    private readonly confirmTimeoutMs?: number,
  ) {}

  publish(message: CrawlMessage): Promise<void> {
    return publishConfirmed(
      this.channel,
      {
        exchange: EXCHANGES.crawl,
        routingKey: QUEUES.requests,
        content: Buffer.from(JSON.stringify(message)),
        options: { persistent: true, contentType: 'application/json', messageId: message.uid },
      },
      this.confirmTimeoutMs,
    );
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

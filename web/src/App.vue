<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

import { renderMarkdown } from './utils/markdown.js';
import { validateUrlInput } from './utils/url-validation.js';
import { useCrawl } from './composables/use-crawl.js';

const { view, busy, submit, retry, dispose } = useCrawl();

const url = ref('');
// Validation is immediate, but the message waits until the user has typed something.
const touched = ref(false);
const validationMessage = computed(() => validateUrlInput(url.value));
const showValidation = computed(() => touched.value && validationMessage.value !== null);
const canSubmit = computed(() => !busy.value && validationMessage.value === null);
const descriptionHtml = computed(() =>
  view.value.name === 'success' ? renderMarkdown(view.value.result.description) : '',
);

function onSubmit(): void {
  touched.value = true;
  if (canSubmit.value) void submit(url.value.trim());
}

onBeforeUnmount(dispose);
</script>

<template>
  <main class="page">
    <header>
      <h1>Mini Crawler</h1>
      <p class="lead">
        Inserisci l’URL di una pagina web: ne catturiamo uno screenshot completo e ne descriviamo il
        design.
      </p>
    </header>

    <form class="crawl-form" novalidate @submit.prevent="onSubmit">
      <label for="url">URL della pagina</label>
      <div class="field">
        <input
          id="url"
          v-model="url"
          type="url"
          inputmode="url"
          autocomplete="url"
          placeholder="https://example.com"
          :disabled="busy"
          :aria-invalid="showValidation"
          :aria-describedby="showValidation ? 'url-error' : undefined"
          @input="touched = true"
        />
        <button type="submit" :disabled="!canSubmit">Crawl</button>
      </div>
      <p v-if="showValidation" id="url-error" class="field-error">{{ validationMessage }}</p>
    </form>

    <section v-if="view.name === 'success'" class="result" aria-labelledby="result-title">
      <h2 id="result-title">Analisi del design</h2>
      <p class="meta">
        <a :href="view.result.url" target="_blank" rel="noopener noreferrer">{{
          view.result.url
        }}</a>
        · completato in {{ (view.result.tookMs / 1000).toFixed(1) }} s
      </p>
      <!-- eslint-disable-next-line vue/no-v-html -- sanitized by renderMarkdown() -->
      <div class="description" v-html="descriptionHtml"></div>
      <figure class="screenshot">
        <img :src="view.result.image" :alt="`Screenshot completo di ${view.result.url}`" />
      </figure>
    </section>

    <section v-else-if="view.name === 'error'" class="error" role="alert">
      <h2>Analisi non riuscita</h2>
      <p>{{ view.message }}</p>
      <button type="button" @click="retry">Riprova</button>
    </section>

    <div v-if="busy" class="loader" role="status" aria-live="polite">
      <div class="loader-box">
        <span class="spinner" aria-hidden="true"></span>
        <p>{{ view.name === 'submitting' ? 'Invio della richiesta…' : 'Analisi in corso…' }}</p>
        <p class="hint">Può richiedere fino a 30 secondi.</p>
      </div>
    </div>
  </main>
</template>

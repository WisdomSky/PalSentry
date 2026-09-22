<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppShell from './components/AppShell.vue';
import Toaster from './components/Toaster.vue';
import { useSessionStore } from './stores/session';
import { useServerStore } from './stores/server';

const route = useRoute();
const session = useSessionStore();
const server = useServerStore();

/** The login screen renders bare; everything else sits inside the app shell. */
const isPublic = computed(() => route.meta.public === true);

/**
 * Polling lifetime is tied to authentication, not to a specific view, so the data stays warm
 * while the operator moves between the dashboard, the map, and the audit log.
 */
onMounted(async () => {
  if (session.authenticated) await server.start();
});

onBeforeUnmount(() => {
  server.stop();
});

watch(
  () => session.authenticated,
  async (authenticated) => {
    if (authenticated) {
      await server.start();
    } else {
      server.stop();
      server.reset();
    }
  },
);
</script>

<template>
  <Toaster />
  <RouterView v-if="isPublic" />
  <AppShell v-else />
</template>

/**
 * Hub entry point.
 *
 * Two things happen here and nothing else: the provider frames get a home in the DOM, and the hub
 * starts. Everything the page does afterwards is a consequence of a state transition, so there is no
 * imperative startup sequence hidden in a component.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

import { HubApp } from './app/hub-app';
import { App } from './ui/App';

const root = document.querySelector<HTMLElement>('#app');
const frames = document.querySelector<HTMLElement>('#provider-frames');
if (!root || !frames) throw new Error('hub page is missing #app or #provider-frames');

const hub = new HubApp();

createRoot(root).render(
  <StrictMode>
    <App hub={hub} />
  </StrictMode>,
);

// Started after the first render so the page shows its shell — and its "connecting to
// organisations" state — while the frames load. A blank page during a four-second grace period
// reads as broken.
void hub.start(frames).catch((error: unknown) => {
  console.error('hub failed to start', error);
});

// Exposed for the recording rig and for a judge with DevTools open. Read-only in practice: nothing
// in the product reads this back.
(window as unknown as { threshold: HubApp }).threshold = hub;

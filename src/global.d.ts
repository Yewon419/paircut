import type { PaircutApi } from '../shared/api';

declare global {
  interface Window {
    api: PaircutApi;
  }
}

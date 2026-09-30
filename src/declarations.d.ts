/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
declare module '*.css';

interface Window {
  bengkelin: import('./shared/bridge').BengkelinApi;
}

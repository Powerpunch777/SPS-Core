export {};

declare global {
  interface Window {
    spsDesktop?: {
      signOut: () => Promise<unknown>;
    };
  }
}

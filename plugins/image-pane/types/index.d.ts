export type Shown = { path: string; title: string; caption: string }

declare module 'claude-code' {
  interface PluginState {
    'image-pane': { images: Shaped<Shown[]>; index: Shaped<number> }
  }
}

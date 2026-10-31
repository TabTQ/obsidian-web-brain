// Hooks the editor uses to talk to the app shell (set by the app at startup).

export const editorHooks = {
  navigate: (_link: string, _source: string, _newTab: boolean): void => {},
  linkExists: (_link: string, _source: string): boolean => true,
  searchTag: (_tag: string): void => {},
  openExternal: (url: string) => window.open(url, "_blank", "noopener,noreferrer"),
};

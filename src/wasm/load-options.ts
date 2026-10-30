export interface ReplayLoadOptions {
  modifiers: boolean;
  winProbability: boolean;
}
export const DEFAULT_LOAD_OPTIONS: Readonly<ReplayLoadOptions> = Object.freeze({
  modifiers: false,
  winProbability: false,
});

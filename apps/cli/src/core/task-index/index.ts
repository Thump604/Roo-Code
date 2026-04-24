/**
 * Task index — lightweight local index of recent CLI tasks.
 *
 * Stores metadata at ~/.mesa/task-index.json (with ~/.roo fallback).
 * Does not store secrets or full prompt text.
 */

export { TaskIndex } from "./store.js"
export type { TaskIndexEntry, TaskIndexFile } from "./types.js"

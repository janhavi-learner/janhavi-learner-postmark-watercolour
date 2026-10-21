// Where the engine reports problems (shader compile errors, missing GPU features).
// createEngine({ onError }) sets it; by default they go to the console.
let handler = (message) => console.error(message);

export function setErrorHandler(fn) {
  handler = fn;
}

export function showError(message) {
  handler(message);
}

export function instrumentSource(source) {
  return (
    source +
    '\nwindow.pickerTest = { request: (...args) => request(...args), getState: () => state };'
  );
}

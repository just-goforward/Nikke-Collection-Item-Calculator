export function commitFocusedInput() {
  const activeElement = document.activeElement;
  if (
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLSelectElement ||
    activeElement instanceof HTMLTextAreaElement
  ) {
    activeElement.blur();
  }
}

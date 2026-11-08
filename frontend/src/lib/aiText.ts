/** Presentation cleanup for previously cached replies; not a moderation bypass. */
export function cleanAiText(text: string): string {
  let value = text.trim();
  const footer = /(?:^|\r?\n)[ \t]*(?:User Safety|Response Safety)[ \t]*:[ \t]*safe[ \t]*$/i;
  while (footer.test(value)) value = value.replace(footer, "").trimEnd();
  return value;
}

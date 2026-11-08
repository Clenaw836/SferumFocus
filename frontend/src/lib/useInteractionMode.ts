import {useEffect} from 'preact/hooks';
/** Keyboard navigation stays immediate; pointer presses get spatial feedback. */
export function useInteractionMode(): void {
  useEffect(() => {
    const root = document.documentElement;
    const keyboard = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey && !event.altKey) root.dataset.input = 'keyboard';
    };
    const pointer = () => { root.dataset.input = 'pointer'; };
    document.addEventListener('keydown', keyboard, true);
    document.addEventListener('pointerdown', pointer, true);
    return () => {
      document.removeEventListener('keydown', keyboard, true);
      document.removeEventListener('pointerdown', pointer, true);
      delete root.dataset.input;
    };
  }, []);
}

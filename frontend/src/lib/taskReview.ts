import type { Task } from './types';
/** Editable review accepts an empty subject while typing; display splitTitle
 * deliberately does not. Keep the two contracts separate. */
export function reviewParts(title: string): {
    subject: string;
    detail: string;
} {
    const i = title.indexOf(':');
    return i >= 0 ? { subject: title.slice(0, i), detail: title.slice(i + 1).trimStart() } : { subject: title, detail: '' };
}
export function reviewValid(task: Task): boolean {
    return !!reviewParts(task.title).subject.trim() && task.title.length <= 300 &&
        Number.isInteger(task.planned_minutes) && task.planned_minutes >= 1 && task.planned_minutes <= 600;
}

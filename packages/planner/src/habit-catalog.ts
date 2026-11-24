// Fertige Habit-Vorlagen, die jeder mit einem Tipp übernehmen kann (/habit vorlagen).
// Mindestzeit = 100 % in der Statistik. Frei änderbar: einfach hier ergänzen.
import type { Category } from './store.ts';

export interface HabitTemplate {
  key: string;
  label: string;
  category: Category;
  min: number;
  max: number;
  /** Erinnerungszeit (optional) */
  time?: string;
  days?: number[];
  emoji: string;
}

export const HABIT_CATALOG: HabitTemplate[] = [
  { key: 'ernaehrung', label: 'Gesunde Ernährung / Smoothie', category: 'habit', min: 5, max: 45, emoji: '🥗' },
  { key: 'stretching', label: 'Stretching am Vormittag', category: 'habit', min: 10, max: 20, time: '09:00', emoji: '🤸' },
  { key: 'morgenlektuere', label: 'Morgenlektüre', category: 'habit', min: 30, max: 60, time: '07:00', emoji: '📖' },
  { key: 'meditation', label: 'Meditation', category: 'habit', min: 10, max: 20, emoji: '🧘' },
  { key: 'spaziergang', label: 'Spaziergang', category: 'habit', min: 20, max: 45, emoji: '🚶' },
  { key: 'kaltduschen', label: 'Kalt duschen', category: 'habit', min: 2, max: 5, emoji: '🧊' },
  { key: 'journaling', label: 'Journaling / Tagebuch', category: 'habit', min: 5, max: 15, time: '21:30', emoji: '✍️' },
  { key: 'weiterbildung', label: 'Weiterbildung / Lernen', category: 'hustle', min: 30, max: 60, emoji: '🎓' },
  { key: 'instagram', label: 'Instagram pushen', category: 'hustle', min: 30, max: 60, emoji: '📸' },
  { key: 'beitrag', label: 'Beitrag erstellen', category: 'hustle', min: 15, max: 60, emoji: '🎬' },
  { key: 'nachrichten', label: 'Nachrichten beantworten', category: 'hustle', min: 15, max: 30, emoji: '💬' },
];

export const findTemplate = (key: string) => HABIT_CATALOG.find((t) => t.key === key) ?? null;

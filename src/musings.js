// The quiet furniture of a mind that was already here when the owner arrived. The welcome draws one
// line from this small, auditable selection of the Tao Te Ching; it never loads a book or asks a model
// to choose. The text was checked against the owner's 老子.epub (王弼本) on 2026-08-31.
//
// The waiting words name the shape of attention, not a claimed inner state — "Listening", not
// "Thinking hard". Naming the posture is honest about a machine; naming the feeling is not.

export const MUSINGS = Object.freeze([
  "道可道，非常道。名可名，非常名。",
  "上善若水。水善利万物而不争，处众人之所恶，故几于道。",
  "人法地，地法天，天法道，道法自然。",
  "知人者智，自知者明。胜人者有力，自胜者强。",
  "道生一，一生二，二生三，三生万物。",
  "知者不言，言者不知。",
  "祸兮福之所倚，福兮祸之所伏。",
  "天下难事必作于易，天下大事必作于细。",
  "合抱之木，生于毫末；九层之台，起于累土；千里之行，始于足下。",
  "慎终如始，则无败事。",
  "天之道，利而不害；圣人之道，为而不争。",
]);

export const WAITING_WORDS = Object.freeze([
  "Listening", "Settling", "Breathing", "Gathering",
  "Turning it over", "Unfolding", "Sitting with it", "Clearing",
]);

// Slow enough that the word is read rather than watched. A label that changes faster than a person
// finishes reading it is a spinner wearing words.
export const WAITING_ROTATION_MS = 4000;

const at = (list, index) => list[((Math.trunc(index) % list.length) + list.length) % list.length];

export const musing = (random = Math.random) => at(MUSINGS, random() * MUSINGS.length);
export const waitingWord = index => at(WAITING_WORDS, index);
export const waitingStart = (random = Math.random) => Math.floor(random() * WAITING_WORDS.length);

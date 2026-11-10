/** The same limit the API enforces (MAX_SCHOOL_CITY_LENGTH in user-profile-handler). */
export const SCHOOL_MAX_LENGTH = 100;
/** What the API stores for a school nobody gave; shown as an empty field. */
export const SCHOOL_PLACEHOLDER = 'Not specified';

/** A stored school, as the field shows it: the placeholder reads as empty. */
export const schoolForField = (school: string | undefined | null): string =>
  !school || school === SCHOOL_PLACEHOLDER ? '' : school;

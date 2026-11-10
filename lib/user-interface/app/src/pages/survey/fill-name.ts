import { fillTemplate } from '../../common/active-child';

/**
 * A sentence with the child's name in it, starting with a capital.
 *
 * A child with no name yet is "your child", and a sentence that opens with the
 * name came out as "your child's summary is ready." So where the sentence
 * opens with {name}, its first letter is upper-cased after filling. A real
 * name is unchanged, a name mid-sentence is left alone, and scripts without
 * case (Chinese, Arabic) are untouched.
 */
export const fillName = (template: string, name: string): string => {
  const sentence = fillTemplate(template, { name });
  if (!template.startsWith('{name}')) return sentence;
  return sentence.charAt(0).toLocaleUpperCase() + sentence.slice(1);
};

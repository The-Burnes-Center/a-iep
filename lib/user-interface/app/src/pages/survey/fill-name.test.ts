import { describe, expect, test } from 'vitest';
import { fillName } from './fill-name';

describe('a sentence that opens with the child', () => {
  test('starts with a capital when the child has no name yet', () => {
    expect(fillName("{name}'s summary is ready.", 'your child')).toBe("Your child's summary is ready.");
    expect(fillName('{name} está listo', 'su hijo/a')).toBe('Su hijo/a está listo');
  });

  test('leaves a real name, a mid-sentence name and caseless scripts alone', () => {
    expect(fillName("{name}'s IEP", 'Maya')).toBe("Maya's IEP");
    expect(fillName('Upload for {name}', 'your child')).toBe('Upload for your child');
    expect(fillName('{name}的摘要已准备好。', '您的孩子')).toBe('您的孩子的摘要已准备好。');
    // Only a sentence that opens with the name is touched.
    expect(fillName('de {name}', 'Maya')).toBe('de Maya');
  });
});

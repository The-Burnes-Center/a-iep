/**
 * The two things about documents.spec.ts stages 10 and 11 that running the
 * journey cannot check: WHICH language a given night asks the finished
 * document for, and whether everything downstream of that choice holds for
 * each language in the rotation.
 *
 * A nightly proves one language per run, three nights apart. Waiting three
 * nights to discover that the Vietnamese assertion is satisfiable by English
 * prose, or that Arabic's RTL flip breaks the way the nav bar is addressed, is
 * not a test strategy. These are pure checks over the same helpers the journey
 * imports, so they answer both questions in under a second.
 *
 * Deliberately NOT @pipeline-tagged: it costs no OCR, no LLM call and no
 * translation, so it gates every staging deploy as well as the nightly. It
 * lives here rather than in the root jest suite because jest.config.js only
 * looks under test/lambdas and test/infra, and this is the only suite that
 * ever loads e2e/helpers.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
  APP_NAV_ICONS,
  APP_NAV_ROUTES,
  ENABLED_LANGUAGES,
  ON_DEMAND_LANGUAGE,
  ON_DEMAND_LANGUAGES,
  ON_DEMAND_LANGUAGE_ENV,
  ON_DEMAND_LANGUAGE_REASON,
  TRANSLATION_LANGUAGE,
  appNavButton,
  expectOnDemandTranslation,
  pickOnDemandLanguage,
} from '../helpers/documents';

/** A date on the nightly's own schedule (09:00 UTC), for readable cases. */
const night = (isoDay: string): Date => new Date(`${isoDay}T09:00:00.000Z`);

test.describe('the on-demand translation language rotates', () => {
  test('rotates over every language the deployment actually ships', () => {
    // ENABLED_LANGUAGES is restated in the helper because the e2e package
    // cannot import from lib/ (its own tsconfig and node_modules), so it is
    // read as TEXT here instead, exactly as test/infra/enabled-languages.test.ts
    // reads vite.config.ts. Without this, adding a sixth language to the app
    // would silently leave the rotation covering five.
    const deployConfig = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lib', 'user-interface', 'index.ts'),
      'utf8'
    );
    const declared = /const ALL_LANGUAGES[^=]*=\s*\[([^\]]*)\]/.exec(deployConfig);
    expect(declared, 'ALL_LANGUAGES no longer parses out of lib/user-interface/index.ts').not
      .toBeNull();

    const shipped = (declared?.[1] ?? '')
      .split(',')
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    expect(
      [...ENABLED_LANGUAGES],
      'the staging deployment ships a different set of languages than this suite rotates over ' +
      '(lib/user-interface/index.ts#ALL_LANGUAGES changed): update ENABLED_LANGUAGES in ' +
      'e2e/helpers/documents.ts, and give any new language a TRANSLATED_SCRIPTS rule'
    ).toEqual(shipped);
  });

  test('rotates over exactly the languages the upload does not already produce', () => {
    // The upload runs with the profile on TRANSLATION_LANGUAGE, so the
    // document lands holding English plus that one. Asking for either again
    // would leave stage 10 with no banner: the summary page only offers to
    // translate into a language the document is MISSING.
    expect(ON_DEMAND_LANGUAGES).not.toContain('en');
    expect(ON_DEMAND_LANGUAGES).not.toContain(TRANSLATION_LANGUAGE);
    expect(new Set(ON_DEMAND_LANGUAGES)).toEqual(
      new Set(ENABLED_LANGUAGES.filter((l) => l !== 'en' && l !== TRANSLATION_LANGUAGE))
    );

    // Named explicitly as well as derived: Arabic is the one that matters,
    // because it ships on staging and is dark on prod, and it is what brings
    // RTL into the journey. If a change to the enabled list drops it, this
    // fails and someone decides that on purpose.
    expect(ON_DEMAND_LANGUAGES).toEqual(['zh', 'vi', 'ar']);
  });

  test('covers every language over consecutive nights, then repeats', () => {
    const period = ON_DEMAND_LANGUAGES.length;
    // Two full turns plus one, so both "covers everything" and "repeats with
    // the right period" are read off the same sequence.
    const nights = Array.from(
      { length: period * 2 + 1 },
      (_, offset) => new Date(Date.UTC(2026, 7, 12 + offset, 9))
    );
    const picked = nights.map((when) => pickOnDemandLanguage(when, undefined).language);
    console.log(
      '[rotation] ' +
      nights.map((when, i) => `${when.toISOString().slice(0, 10)}=${picked[i]}`).join(' ')
    );

    expect(
      new Set(picked.slice(0, period)),
      `the first ${period} nights did not cover every language: ${picked.join(', ')}`
    ).toEqual(new Set(ON_DEMAND_LANGUAGES));
    expect(
      picked.slice(period),
      'the rotation did not repeat itself after a full turn'
    ).toEqual(picked.slice(0, period + 1));
    // Consecutive nights differ, i.e. it really advances rather than sticking.
    picked.slice(1).forEach((language, index) => {
      expect(language).not.toBe(picked[index]);
    });
  });

  test('picks the same language for every run on one UTC day', () => {
    // The point of a date-derived index: a nightly that failed at 09:00 UTC is
    // re-runnable by hand at 16:00 and exercises the same language, instead of
    // silently testing a different one.
    const morning = new Date('2026-08-12T00:00:00.000Z');
    const evening = new Date('2026-08-12T23:59:59.999Z');
    const nextDay = new Date('2026-08-13T00:00:00.000Z');

    expect(pickOnDemandLanguage(morning, undefined).language).toBe(
      pickOnDemandLanguage(evening, undefined).language
    );
    expect(pickOnDemandLanguage(nextDay, undefined).language).not.toBe(
      pickOnDemandLanguage(evening, undefined).language
    );
  });

  test('says how it chose, so a failed night can be reproduced', () => {
    // Stage 10 logs this line and nothing else explains the choice, so it has
    // to carry the derivation AND the way to replay it.
    const { reason } = pickOnDemandLanguage(night('2026-08-12'), undefined);
    expect(reason).toContain('UTC day');
    expect(reason).toContain(ON_DEMAND_LANGUAGE_ENV);
    for (const language of ON_DEMAND_LANGUAGES) expect(reason).toContain(language);

    expect(pickOnDemandLanguage(night('2026-08-12'), 'ar').reason).toContain(
      ON_DEMAND_LANGUAGE_ENV
    );
  });

  test('can be forced with the env override', () => {
    for (const language of ON_DEMAND_LANGUAGES) {
      expect(pickOnDemandLanguage(night('2026-08-12'), language).language).toBe(language);
      // Whitespace and case are what a hand-typed override actually looks like.
      expect(pickOnDemandLanguage(night('2026-08-12'), ` ${language.toUpperCase()} `).language)
        .toBe(language);
    }
  });

  test('refuses an override the journey could not use', () => {
    // 'en' and 'es' are already on the document, so the banner never appears
    // and the stage would fail deep inside a 6-minute timeout instead of here.
    for (const rejected of ['en', TRANSLATION_LANGUAGE, 'fr', 'zz']) {
      expect(
        () => pickOnDemandLanguage(night('2026-08-12'), rejected),
        `${ON_DEMAND_LANGUAGE_ENV}=${rejected} was accepted`
      ).toThrow(new RegExp(ON_DEMAND_LANGUAGE_ENV));
    }
  });

  test('this run resolved to one of them, with a reason attached', () => {
    // The journey reads these two constants, resolved once per worker so that
    // stages 10 and 11 agree even if a run straddles UTC midnight.
    expect(ON_DEMAND_LANGUAGES).toContain(ON_DEMAND_LANGUAGE);
    expect(ON_DEMAND_LANGUAGE_REASON).toContain(ON_DEMAND_LANGUAGE_ENV);
  });
});

/**
 * Synthetic prose, written for this test, in the register a translated IEP
 * summary uses. Each is comfortably over the helper's 120-character floor.
 */
const SAMPLE: Record<string, string> = {
  // Longer than it looks like it needs to be: Chinese packs far more meaning
  // per character than English, so a passage that clears the helper's
  // 120-character floor is a genuinely substantial one. Real summaries run to
  // several hundred characters.
  zh:
    '这是学生个别化教育计划的中文摘要。学校每周将提供一次语言治疗服务和职业治疗服务，' +
    '并在整个学年中持续跟踪孩子的学习进步情况。家长可以随时联系学校的特殊教育团队，' +
    '了解年度目标的完成情况以及课堂上提供的各项便利措施。本计划还说明了评估的安排、' +
    '家长参与会议的方式，以及学生在普通班级中接受支持的时间比例。',
  vi:
    'Đây là bản tóm tắt kế hoạch giáo dục cá nhân của học sinh. Nhà trường sẽ cung cấp ' +
    'dịch vụ trị liệu ngôn ngữ và trị liệu vận động mỗi tuần một lần, đồng thời theo dõi ' +
    'tiến bộ của em trong suốt năm học. Phụ huynh có thể liên hệ với nhóm giáo dục đặc biệt.',
  ar:
    'هذا ملخص باللغة العربية لبرنامج التعليم الفردي الخاص بالطالب. ستقدم المدرسة خدمات ' +
    'علاج النطق والعلاج الوظيفي مرة واحدة كل أسبوع، وستتابع تقدم الطفل طوال العام الدراسي. ' +
    'يمكن لولي الأمر التواصل مع فريق التربية الخاصة في أي وقت.',
} as const;

/** What an untranslated pane would actually hold. */
const ENGLISH_SAMPLE =
  "This is the English summary of the student's individualized education program. The " +
  'school will provide speech therapy and occupational therapy once a week, and will ' +
  'track progress towards the annual goals throughout the school year.';

/**
 * The language the pipeline already produced, and the reason Latin script
 * alone cannot stand in for a Vietnamese check.
 *
 * Deliberately accent-DENSE, the way real translated Spanish is. A sparsely
 * accented sample would let a Vietnamese rule that had been widened to accept
 * Latin-1 accents slip through on the count alone, which is not the property
 * being claimed here.
 */
const SPANISH_SAMPLE =
  'Este es el resumen en español del programa de educación individualizada del ' +
  'estudiante. La escuela proporcionará terapia del habla y terapia ocupacional una ' +
  'sesión por semana, además de apoyo académico diario. También hará un seguimiento ' +
  'del progreso hacia los objetivos anuales durante todo el año escolar, y la niña ' +
  'recibirá adaptaciones en el aula según su evaluación más reciente.';

/** Where every Spanish accent lives, and where the Vietnamese rule must not look. */
const LATIN1_ACCENTS = /[À-ÿ]/g;

test.describe('the content assertion follows the language', () => {
  test('accepts a real translation into each rotation language', () => {
    for (const language of ON_DEMAND_LANGUAGES) {
      expectOnDemandTranslation(SAMPLE[language], language);
    }
  });

  test('rejects untranslated English for every language', () => {
    // The whole point of the assertion: a pane that quietly kept the English
    // content must not pass as a translation. The sample is plain ASCII, i.e.
    // a real specimen of what an untranslated pane holds.
    expect(/[^\x20-\x7e]/.test(ENGLISH_SAMPLE), 'the English sample is not plain ASCII').toBe(
      false
    );
    for (const language of ON_DEMAND_LANGUAGES) {
      expect(
        () => expectOnDemandTranslation(ENGLISH_SAMPLE, language),
        `English prose satisfied the ${language} check`
      ).toThrow();
    }
  });

  test('rejects Spanish for every language, accents and all', () => {
    // Spanish is the trap for Vietnamese: both are Latin script with
    // diacritics, so "has an accented character" would pass here. The sample
    // has to be accent-DENSE for that to mean anything, otherwise a Vietnamese
    // rule widened to Latin-1 could still fail it on the count alone.
    expect(
      SPANISH_SAMPLE.match(LATIN1_ACCENTS)?.length ?? 0,
      'the Spanish sample is not accented enough to be a real trap for the Vietnamese rule'
    ).toBeGreaterThanOrEqual(10);

    for (const language of ON_DEMAND_LANGUAGES) {
      expect(
        () => expectOnDemandTranslation(SPANISH_SAMPLE, language),
        `Spanish prose satisfied the ${language} check`
      ).toThrow();
    }
  });

  test('each rule accepts only its own language', () => {
    for (const sampleLanguage of ON_DEMAND_LANGUAGES) {
      for (const ruleLanguage of ON_DEMAND_LANGUAGES) {
        const check = () => expectOnDemandTranslation(SAMPLE[sampleLanguage], ruleLanguage);
        if (sampleLanguage === ruleLanguage) {
          expect(check).not.toThrow();
        } else {
          expect(check, `${sampleLanguage} prose satisfied the ${ruleLanguage} check`).toThrow();
        }
      }
    }
  });

  test('accepts Vietnamese however it is normalized', () => {
    // Precomposed (one code point per accented letter) and decomposed (base
    // letter plus combining marks) are both valid UTF-8 for the same text, and
    // only the precomposed form is inside the U+1EA0-U+1EF9 range.
    const decomposed = SAMPLE.vi.normalize('NFD');
    expect(decomposed).not.toBe(SAMPLE.vi.normalize('NFC'));
    expectOnDemandTranslation(decomposed, 'vi');
  });

  test('rejects a pane too short to be a real summary', () => {
    for (const language of ON_DEMAND_LANGUAGES) {
      expect(() => expectOnDemandTranslation(SAMPLE[language].slice(0, 40), language)).toThrow();
    }
  });

  test('refuses to pass a language it has no rule for', () => {
    // A sixth language added to the app would be picked up by the rotation
    // automatically. Accepting its pane unchecked would green-stamp
    // untranslated English, so the missing rule has to be the failure.
    expect(() => expectOnDemandTranslation(ENGLISH_SAMPLE, 'fr')).toThrow(/TRANSLATED_SCRIPTS/);
  });
});

/**
 * The nav bar, rendered the way MobileTopNavigation renders it, in both
 * writing directions.
 *
 * This is the RTL risk in the rotation: on the nights it picks Arabic, stage 10
 * taps Account and comes back with the whole app in RTL. The bar is a flex row,
 * and `dir="rtl"` reverses how a flex row is PAINTED. The question the journey
 * cannot answer for itself is whether it reverses the DOM as well, because a
 * lookup that addressed the buttons by position would then tap the wrong one
 * and the stage would fail somewhere else entirely.
 *
 * The markup and the CSS here are copied from MobileTopNavigation.tsx and
 * MobileTopNavigation.css; the labels are the real Arabic ones from
 * translations/ar.json.
 */
const NAV_FIXTURE = [
  { route: '/summary-and-translations', icon: 'file-description', label: 'الملخص' },
  { route: '/support-center', icon: 'heart-handshake', label: 'الدعم' },
  { route: '/parent-rights', icon: 'info-circle', label: 'الحقوق' },
  { route: '/account-center', icon: 'user', label: 'الحساب' },
] as const;

const navMarkup = (dir: 'ltr' | 'rtl'): string => `
<!doctype html>
<html dir="${dir}" lang="${dir === 'rtl' ? 'ar' : 'en'}">
<head><meta charset="utf-8"><style>
  body { margin: 0; }
  .navigation-container { display: flex; justify-content: space-around; align-items: center; }
  .nav-item { display: flex; flex-direction: column; align-items: center; min-width: 60px; }
</style></head>
<body>
  <div class="mobile-top-navigation"><div class="navigation-container">
    ${NAV_FIXTURE.map((item) => `
      <button class="nav-item" aria-label="Navigate to ${item.label}">
        <svg class="tabler-icon tabler-icon-${item.icon}" width="24" height="24"></svg>
        <span class="nav-label">${item.label}</span>
      </button>`).join('')}
  </div></div>
</body></html>`;

test.describe('the app nav is addressed independently of writing direction', () => {
  test('the icons it looks for are the ones the component actually renders', () => {
    // The fixture below is a REPLICA, so on its own it could keep passing
    // while the real component moved on. This reads MobileTopNavigation's own
    // navigationItems array and pins the route -> icon pairing against it, on
    // every deploy rather than on the next nightly.
    const source = fs.readFileSync(
      path.join(
        __dirname, '..', '..',
        'lib', 'user-interface', 'app', 'src', 'components', 'MobileTopNavigation.tsx'
      ),
      'utf8'
    );
    // PascalCase component name to the class @tabler/icons-react stamps on the
    // svg it renders: IconFileDescription -> tabler-icon-file-description.
    const kebab = (pascal: string): string =>
      pascal.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

    const rendered: Record<string, string> = {};
    for (const [, icon, route] of source.matchAll(
      /icon:\s*Icon(\w+),[\s\S]*?route:\s*'([^']+)'/g
    )) {
      rendered[route] = kebab(icon);
    }

    expect(
      rendered,
      'MobileTopNavigation renders different route/icon pairs than tapAppNav looks for ' +
      '(its navigationItems array changed, or no longer parses): update APP_NAV_ICONS in ' +
      'e2e/helpers/documents.ts, or the nightly will tap the wrong nav button'
    ).toEqual({ ...APP_NAV_ICONS });
  });

  test('the icon lookup finds the right button in LTR and in RTL', async ({ page }) => {
    for (const dir of ['ltr', 'rtl'] as const) {
      await page.setContent(navMarkup(dir));
      expect(await page.evaluate(() => document.documentElement.dir)).toBe(dir);

      for (const item of NAV_FIXTURE) {
        const button = appNavButton(page, item.route);
        await expect(
          button,
          `the ${item.icon} button was not uniquely addressable under dir=${dir}`
        ).toHaveCount(1);
        await expect(button).toHaveAttribute('aria-label', `Navigate to ${item.label}`);
      }
    }
  });

  test('RTL flips how the bar is painted but not the order of the DOM', async ({ page }) => {
    const domOrder = async (): Promise<string[]> =>
      page.locator('.mobile-top-navigation button[aria-label^="Navigate to "]').evaluateAll(
        (buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? '')
      );
    const leftEdges = async (): Promise<number[]> =>
      Promise.all(
        NAV_FIXTURE.map(async (item) => {
          const box = await appNavButton(page, item.route).boundingBox();
          return box?.x ?? Number.NaN;
        })
      );

    await page.setContent(navMarkup('ltr'));
    const ltrDom = await domOrder();
    const ltrX = await leftEdges();

    await page.setContent(navMarkup('rtl'));
    const rtlDom = await domOrder();
    const rtlX = await leftEdges();

    // The finding this whole change rests on: document order is untouched, so
    // an nth()-based lookup would NOT have picked the wrong button. The icon
    // lookup does not care either way, and this is what says so out loud.
    expect(
      rtlDom,
      'dir="rtl" reordered the nav buttons in the DOM, so any positional lookup is unsafe'
    ).toEqual(ltrDom);
    expect(ltrDom).toHaveLength(NAV_FIXTURE.length);
    expect(APP_NAV_ROUTES).toEqual(NAV_FIXTURE.map((item) => item.route));

    // ...and the paint order really is mirrored, so this is a live check and
    // not one that would pass on an LTR page by accident.
    const ascending = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]);
    expect(ascending(ltrX), `LTR left edges were not left-to-right: ${ltrX}`).toBe(true);
    expect(
      ascending([...rtlX].reverse()),
      `RTL did not mirror the bar (left edges ${rtlX}), so this run proves nothing about RTL`
    ).toBe(true);
  });
});

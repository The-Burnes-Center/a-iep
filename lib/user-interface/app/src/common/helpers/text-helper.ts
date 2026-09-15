export abstract class TextHelper {
  static getTextFilterCounterText(count = 0) {
    return `${count} ${count === 1 ? "match" : "matches"}`;
  }

  static getHeaderCounterText(
    items: ReadonlyArray<unknown>,
    selectedItems: ReadonlyArray<unknown> | undefined
  ) {
    return selectedItems && selectedItems?.length > 0
      ? `(${selectedItems.length}/${items.length})`
      : `(${items.length})`;
  }

  /**
   * Formats a Unix timestamp (seconds since epoch) to a human-readable date string
   * @param timestamp - Unix timestamp in seconds
   * @param languageCode - Language code ('en', 'es', 'vi', 'zh') to determine locale
   * @returns Formatted date string (e.g., "May 23, 2025"), or '' if it is not a timestamp
   */
  static formatUnixTimestamp(timestamp: number | undefined, languageCode: string = 'en'): string {
    // Nothing to say beats "Invalid Date" in front of a parent, and the type
    // above is not a guarantee: this reads a DynamoDB field off an API
    // response. The document row holds its last-update time in TWO attributes
    // and only one of them is in seconds -- the other is an ISO string, whose
    // `* 1000` below is NaN. The callers' own `value && ...` guards do not
    // catch it, because a non-empty string is truthy.
    if (!timestamp || typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      return '';
    }
    
    // Map language codes to proper locale strings
    const localeMap: Record<string, string> = {
      'en': 'en-US',
      'es': 'es-ES',
      'vi': 'vi-VN',
      'zh': 'zh-CN',
      // nu-latn keeps Western digits so dates match page references
      // to the original English IEP document
      'ar': 'ar-u-nu-latn'
    };
    
    const locale = localeMap[languageCode] || 'en-US';
    
    // Convert Unix timestamp (seconds) to milliseconds for JavaScript Date
    const date = new Date(timestamp * 1000);
    
    // Format the date based on locale.
    //
    // Vietnamese renders as "5 tháng 8, 2026". That comma looks anglicized
    // next to the other locales, and written Vietnamese normally joins the
    // year with "năm" ("5 tháng 8 năm 2026"). It is NOT a bug: `d MMMM, y` is
    // CLDR's own long-date pattern for vi, so this is what Android, iOS and
    // Chrome all show, and matching the rest of a parent's phone was judged
    // worth more than the more formal wording. Reviewed and kept deliberately;
    // do not special-case it without a native speaker asking for the change.
    const options: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    };
    
    return date.toLocaleDateString(locale, options);
  }
}

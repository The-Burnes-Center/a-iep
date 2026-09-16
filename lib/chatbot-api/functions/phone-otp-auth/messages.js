/**
 * Every message A-IEP sends a parent, in the five languages the app speaks.
 *
 * Languages match the app's SUPPORTED_LANGUAGES (en, es, zh, vi, ar). The
 * language is resolved from, in order:
 *   1. clientMetadata.language (the UI language sent by the frontend)
 *   2. the user's profile in DynamoDB (loginLanguage, secondary, primary)
 *   3. the 'locale' user attribute
 *   4. English
 *
 * Templates Cognito fills in itself keep its `{####}` placeholder; the ones
 * this service renders use `{code}` and `{minutes}`. Senders must interpolate
 * with `replaceAll`, not `replace`: `{minutes}` appears in both the preheader
 * and the body of an email, and `replace` would fill the first and leave the
 * second reading literally "{minutes}".
 *
 * ── What goes in one of these, and what does not ────────────────────────
 *
 * Four things and no more: who it is from, what the code is for, how long it
 * lasts, and what to do if the parent did not ask for it.
 *
 * Never a child's name, a document name, or any other record detail. The rule
 * against logging document content applies harder to a string that leaves our
 * systems entirely: an SMS crosses carriers and lands on a lock screen, and an
 * email is retained by a mail provider we do not control. Nothing here
 * interpolates anything but a code and a number of minutes, and the tests
 * assert that a profile field handed to a sender cannot reach a body.
 *
 * Only the custom-auth login code says how long it lasts. Its five minutes is
 * ours: create-auth-challenge issues it, verify-auth-challenge enforces it and
 * the pool's authSessionValidity matches. The Cognito-rendered messages below
 * (sign-up verification, password reset) expire on Cognito's own schedule,
 * which this codebase does not configure, so they promise no duration rather
 * than quote one we would not be keeping.
 *
 * ── Why the SMS copy is as short as it is ───────────────────────────────
 *
 * A carrier bills per 140-byte segment. A message of purely GSM 03.38
 * characters fits 160 of them; ONE character outside that alphabet re-encodes
 * the whole message as UCS-2, which fits 70. Spanish, Chinese, Vietnamese and
 * Arabic are all over that line, so the non-English texts have a 70-character
 * budget where English has 160.
 *
 * Spanish is the trap, and it is not obvious: é ñ ü ¿ ¡ are all in GSM-7, but
 * á í ó ú are not. The single `ó` in "código" is what moves a Spanish message
 * to the 70-character budget. That is not a reason to misspell Spanish -- a
 * one-segment UCS-2 message and a one-segment GSM-7 message cost exactly the
 * same, because segments are what is billed. It is a reason to keep every
 * translation under 70 characters, which is what test/lambdas asserts.
 *
 * A message that spills into a second segment costs twice as much to send and
 * is one more thing that can arrive in pieces. Length is the only lever we
 * have on either. Nothing errors when it happens and the handset reassembles
 * the parts, so only a test catches it.
 *
 * "Msg & data rates may apply" and the STOP/HELP line were removed from the
 * texts on purpose, not lost. CTIA's Short Code Monitoring Handbook classes
 * two-factor codes as a single-message program, which is not required to
 * carry either in the message body, and both disclosures already appear on
 * the phone-number entry screen (`auth.smsFrequencyDisclaimer` and
 * `auth.smsConsentMobile`, present in all five dictionaries). Keep them there:
 * if that screen ever loses them, they have to come back here.
 *
 * There is deliberately no link in any text. Carriers filter SMS containing
 * links, and a sign-in message that trains a parent to tap something is a
 * phishing lesson.
 */

const { buildOtpEmailHtml, buildOtpEmailText } = require('./email-template');

const SUPPORTED_LANGUAGES = ['en', 'es', 'zh', 'vi', 'ar'];

// The DynamoDB client is created lazily: most invocations resolve the
// language from clientMetadata and never need the profile lookup.
let docClient = null;
function getDocClient() {
    if (!docClient) {
        const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
        const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
        const dynamodbClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
        docClient = DynamoDBDocumentClient.from(dynamodbClient);
    }
    return docClient;
}

/**
 * The words. Markup lives in email-template.js; this table is prose only, so
 * that translating it never means editing HTML.
 *
 * `login` is the custom-auth code this service sends over SMS and SES.
 * `signUp` and `reset` are rendered by Cognito from the CustomMessage trigger.
 */
const COPY = {
    en: {
        isRtl: false,
        otpLoginSms: 'A-IEP login code: {code}\nExpires in {minutes} minutes. Do not share it.',
        verificationSms: 'A-IEP verification code: {####}\nDo not share it.',
        authenticationSms: 'A-IEP login code: {####}\nDo not share it.',
        footer: 'A-IEP sent this message. This mailbox is not monitored.',
        login: {
            subject: 'Your A-IEP login code',
            preheader: 'This code expires in {minutes} minutes.',
            heading: 'Your login code',
            validity: 'This code expires in {minutes} minutes. Do not share it with anyone.',
            ignore: 'If you did not try to sign in, you can ignore this email.',
        },
        signUp: {
            subject: 'Verify your A-IEP email address',
            preheader: 'Enter this code to finish setting up your account.',
            heading: 'Verify your email address',
            validity: 'Enter this code in A-IEP to confirm your email address. Do not share it with anyone.',
            ignore: 'If you did not create an A-IEP account, you can ignore this email.',
        },
        reset: {
            subject: 'Reset your A-IEP password',
            preheader: 'Enter this code to choose a new password.',
            heading: 'Reset your password',
            validity: 'Enter this code in A-IEP to choose a new password. Do not share it with anyone.',
            ignore: 'If you did not ask to reset your password, you can ignore this email. Your password will not change.',
        },
    },
    es: {
        isRtl: false,
        // "min." rather than "minutos": the accented o already puts this
        // message on the 70-character budget, and the four characters are the
        // difference between comfortable headroom and none.
        otpLoginSms: 'Código de acceso A-IEP: {code}\nCaduca en {minutes} min. No lo comparta.',
        verificationSms: 'Código de verificación A-IEP: {####}\nNo lo comparta.',
        authenticationSms: 'Código de acceso A-IEP: {####}\nNo lo comparta.',
        footer: 'A-IEP envió este mensaje. Este buzón no recibe respuestas.',
        login: {
            subject: 'Su código de acceso de A-IEP',
            preheader: 'Este código caduca en {minutes} minutos.',
            heading: 'Su código de acceso',
            validity: 'Este código caduca en {minutes} minutos. No lo comparta con nadie.',
            ignore: 'Si usted no intentó iniciar sesión, puede ignorar este correo.',
        },
        signUp: {
            subject: 'Verifique su correo electrónico de A-IEP',
            preheader: 'Ingrese este código para terminar de crear su cuenta.',
            heading: 'Verifique su correo electrónico',
            validity: 'Ingrese este código en A-IEP para confirmar su correo electrónico. No lo comparta con nadie.',
            ignore: 'Si usted no creó una cuenta de A-IEP, puede ignorar este correo.',
        },
        reset: {
            subject: 'Restablezca su contraseña de A-IEP',
            preheader: 'Ingrese este código para elegir una nueva contraseña.',
            heading: 'Restablezca su contraseña',
            validity: 'Ingrese este código en A-IEP para elegir una nueva contraseña. No lo comparta con nadie.',
            ignore: 'Si usted no pidió restablecer su contraseña, puede ignorar este correo. Su contraseña no cambiará.',
        },
    },
    zh: {
        isRtl: false,
        otpLoginSms: 'A-IEP 登录验证码：{code}\n{minutes} 分钟内有效。请勿与他人分享。',
        verificationSms: 'A-IEP 验证码：{####}\n请勿与他人分享。',
        authenticationSms: 'A-IEP 登录验证码：{####}\n请勿与他人分享。',
        footer: '此邮件由 A-IEP 发送。此邮箱不接收回复。',
        login: {
            subject: '您的 A-IEP 登录验证码',
            preheader: '此验证码 {minutes} 分钟内有效。',
            heading: '您的登录验证码',
            validity: '此验证码 {minutes} 分钟内有效。请勿与他人分享。',
            ignore: '如果您没有尝试登录，可以忽略此邮件。',
        },
        signUp: {
            subject: '验证您的 A-IEP 电子邮箱',
            preheader: '输入此验证码以完成账户设置。',
            heading: '验证您的电子邮箱',
            validity: '在 A-IEP 中输入此验证码以确认您的电子邮箱。请勿与他人分享。',
            ignore: '如果您没有创建 A-IEP 账户，可以忽略此邮件。',
        },
        reset: {
            subject: '重置您的 A-IEP 密码',
            preheader: '输入此验证码以设置新密码。',
            heading: '重置您的密码',
            validity: '在 A-IEP 中输入此验证码以设置新密码。请勿与他人分享。',
            ignore: '如果您没有要求重置密码，可以忽略此邮件。您的密码不会更改。',
        },
    },
    vi: {
        isRtl: false,
        otpLoginSms: 'Mã đăng nhập A-IEP: {code}\nHết hạn sau {minutes} phút. Không chia sẻ.',
        verificationSms: 'Mã xác minh A-IEP: {####}\nKhông chia sẻ mã này.',
        authenticationSms: 'Mã đăng nhập A-IEP: {####}\nKhông chia sẻ mã này.',
        footer: 'A-IEP đã gửi thư này. Hộp thư này không nhận thư trả lời.',
        login: {
            subject: 'Mã đăng nhập A-IEP của bạn',
            preheader: 'Mã này hết hạn sau {minutes} phút.',
            heading: 'Mã đăng nhập của bạn',
            validity: 'Mã này hết hạn sau {minutes} phút. Không chia sẻ mã với bất kỳ ai.',
            ignore: 'Nếu bạn không đăng nhập, bạn có thể bỏ qua email này.',
        },
        signUp: {
            subject: 'Xác minh địa chỉ email A-IEP của bạn',
            preheader: 'Nhập mã này để hoàn tất việc tạo tài khoản.',
            heading: 'Xác minh địa chỉ email của bạn',
            validity: 'Nhập mã này trong A-IEP để xác nhận địa chỉ email của bạn. Không chia sẻ mã với bất kỳ ai.',
            ignore: 'Nếu bạn không tạo tài khoản A-IEP, bạn có thể bỏ qua email này.',
        },
        reset: {
            subject: 'Đặt lại mật khẩu A-IEP của bạn',
            preheader: 'Nhập mã này để chọn mật khẩu mới.',
            heading: 'Đặt lại mật khẩu của bạn',
            validity: 'Nhập mã này trong A-IEP để chọn mật khẩu mới. Không chia sẻ mã với bất kỳ ai.',
            ignore: 'Nếu bạn không yêu cầu đặt lại mật khẩu, bạn có thể bỏ qua email này. Mật khẩu của bạn sẽ không thay đổi.',
        },
    },
    ar: {
        isRtl: true,
        otpLoginSms: 'رمز تسجيل الدخول A-IEP: {code}\nينتهي خلال {minutes} دقائق. لا تشاركه.',
        verificationSms: 'رمز التحقق A-IEP: {####}\nلا تشاركه.',
        authenticationSms: 'رمز تسجيل الدخول A-IEP: {####}\nلا تشاركه.',
        footer: 'أرسلت A-IEP هذه الرسالة. هذا البريد لا يستقبل الردود.',
        login: {
            subject: 'رمز تسجيل الدخول إلى A-IEP',
            preheader: 'ينتهي هذا الرمز خلال {minutes} دقائق.',
            heading: 'رمز تسجيل الدخول',
            validity: 'ينتهي هذا الرمز خلال {minutes} دقائق. لا تشاركه مع أي شخص.',
            ignore: 'إذا لم تحاول تسجيل الدخول، يمكنك تجاهل هذه الرسالة.',
        },
        signUp: {
            subject: 'تحقق من بريدك الإلكتروني في A-IEP',
            preheader: 'أدخل هذا الرمز لإكمال إنشاء حسابك.',
            heading: 'تحقق من بريدك الإلكتروني',
            validity: 'أدخل هذا الرمز في A-IEP لتأكيد بريدك الإلكتروني. لا تشاركه مع أي شخص.',
            ignore: 'إذا لم تنشئ حسابًا في A-IEP، يمكنك تجاهل هذه الرسالة.',
        },
        reset: {
            subject: 'إعادة تعيين كلمة مرور A-IEP',
            preheader: 'أدخل هذا الرمز لاختيار كلمة مرور جديدة.',
            heading: 'إعادة تعيين كلمة المرور',
            validity: 'أدخل هذا الرمز في A-IEP لاختيار كلمة مرور جديدة. لا تشاركه مع أي شخص.',
            ignore: 'إذا لم تطلب إعادة تعيين كلمة المرور، يمكنك تجاهل هذه الرسالة. لن تتغير كلمة المرور.',
        },
    },
};

/** Cognito's own placeholder. It fills this in; we never see the code. */
const COGNITO_CODE = '{####}';
/** Ours, interpolated by create-auth-challenge before the send. */
const OUR_CODE = '{code}';

/**
 * Render one language's copy into the flat template set the senders use.
 *
 * Done once at module load rather than per invocation: the output is a set of
 * constant strings with placeholders still in them, so there is nothing
 * per-request to compute and nothing per-request to get wrong.
 */
function buildMessages(lang) {
    const copy = COPY[lang];
    const { isRtl, footer } = copy;

    const email = (section, code) => {
        const content = { lang, isRtl, footer, code, title: section.subject, ...section };
        return { html: buildOtpEmailHtml(content), text: buildOtpEmailText(content) };
    };

    const login = email(copy.login, OUR_CODE);
    const signUp = email(copy.signUp, COGNITO_CODE);
    const reset = email(copy.reset, COGNITO_CODE);

    return {
        otpLoginSms: copy.otpLoginSms,
        otpLoginEmailSubject: copy.login.subject,
        otpLoginEmailText: login.text,
        otpLoginEmailHtml: login.html,
        verificationSms: copy.verificationSms,
        authenticationSms: copy.authenticationSms,
        signUpEmailSubject: copy.signUp.subject,
        signUpEmailBody: signUp.html,
        forgotPasswordEmailSubject: copy.reset.subject,
        forgotPasswordEmailBody: reset.html,
    };
}

const MESSAGES = Object.fromEntries(
    SUPPORTED_LANGUAGES.map((lang) => [lang, buildMessages(lang)]),
);

/**
 * Get the message set for a language, falling back to English.
 */
function getMessages(language) {
    return MESSAGES[language] || MESSAGES.en;
}

/**
 * Normalize a candidate language value to a supported code, or null.
 */
function normalizeLanguage(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const lang = value.toLowerCase().trim();
    return SUPPORTED_LANGUAGES.includes(lang) ? lang : null;
}

/**
 * Resolve the language for a Cognito trigger event:
 * clientMetadata.language -> user profile (DynamoDB) -> 'locale' user
 * attribute -> 'en'.
 *
 * The profile is checked BEFORE the 'locale' attribute: the app keeps
 * profile.secondaryLanguage in sync whenever the user switches language,
 * while 'locale' is only written once at signup and goes stale (a user
 * who signed up in Spanish and later switched to Arabic would otherwise
 * get Spanish SMS forever). 'locale' remains as the bootstrap for brand
 * new users whose profile row doesn't exist yet.
 *
 * Both fallbacks matter because Cognito does NOT forward InitiateAuth
 * clientMetadata to the CreateAuthChallenge / CustomMessage triggers
 * (only RespondToAuthChallenge metadata reaches them), so the first
 * login SMS can only be localized from stored data. The profile lookup
 * is best-effort: any failure falls back so authentication is never
 * blocked by localization.
 *
 * Only the language is read off the profile. Nothing else on that row may
 * be used to build a message body: see the file docblock.
 */
async function resolveLanguage(event) {
    const fromMetadata = normalizeLanguage(event.request?.clientMetadata?.language);
    if (fromMetadata) {
        return fromMetadata;
    }

    const fromLocale = normalizeLanguage(event.request?.userAttributes?.locale);

    const userProfilesTable = process.env.USER_PROFILES_TABLE;
    const userId = event.userName;
    if (!userProfilesTable || !userId) {
        return fromLocale || 'en';
    }

    try {
        const { GetCommand } = require('@aws-sdk/lib-dynamodb');
        const result = await getDocClient().send(new GetCommand({
            TableName: userProfilesTable,
            Key: { userId: userId }
        }));
        const profile = result.Item;
        if (profile) {
            // loginLanguage is stamped by the pre-authentication trigger from
            // the sign-in screen's UI language moments before this runs, so it
            // wins; secondaryLanguage is the in-app preference the app syncs.
            return normalizeLanguage(profile.loginLanguage)
                || normalizeLanguage(profile.secondaryLanguage)
                || normalizeLanguage(profile.primaryLanguage)
                || fromLocale
                || 'en';
        }
    } catch (error) {
        console.warn(`Language lookup failed for user ${userId}, falling back:`, error.message);
    }

    return fromLocale || 'en';
}

module.exports = {
    SUPPORTED_LANGUAGES,
    getMessages,
    normalizeLanguage,
    resolveLanguage,
};

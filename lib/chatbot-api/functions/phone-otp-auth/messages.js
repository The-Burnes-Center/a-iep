/**
 * Localized SMS and email templates for Cognito auth flows.
 *
 * Languages match the app's SUPPORTED_LANGUAGES (en, es, zh, vi, ar).
 * The language is resolved from, in order:
 *   1. clientMetadata.language (the UI language sent by the frontend)
 *   2. the user's profile in DynamoDB (secondaryLanguage, then primaryLanguage)
 *   3. English
 *
 * Templates that Cognito fills in itself keep the {####} code placeholder;
 * the OTP login template uses {code} which create-auth-challenge interpolates.
 * Arabic email bodies are wrapped in dir="rtl" for correct display.
 */

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

const MESSAGES = {
    en: {
        otpLoginSms: 'Your login code for The GovLab AIEP is: {code}. This code expires in {minutes} minutes. Do not share this code. Msg & data rates may apply.',
        verificationSms: 'Your OTP from The GovLab AIEP is: {####}. Do not share this code. Msg & data rates may apply.',
        authenticationSms: 'Your login code for The GovLab AIEP is: {####}. Do not share this code.',
        signUpEmailSubject: 'Your AIEP verification code',
        signUpEmailBody: '<p>Welcome to AIEP!</p><p>Your verification code is: <strong>{####}</strong></p><p>Enter this code to verify your email address.</p>',
        forgotPasswordEmailSubject: 'Reset your AIEP password',
        forgotPasswordEmailBody: '<p>We received a request to reset your AIEP password.</p><p>Your password reset code is: <strong>{####}</strong></p><p>If you did not request this, you can ignore this email.</p>'
    },
    es: {
        otpLoginSms: 'Su código de acceso para The GovLab AIEP es: {code}. Este código expira en {minutes} minutos. No comparta este código. Pueden aplicarse tarifas de mensajes y datos.',
        verificationSms: 'Su código de verificación de The GovLab AIEP es: {####}. No comparta este código. Pueden aplicarse tarifas de mensajes y datos.',
        authenticationSms: 'Su código de acceso para The GovLab AIEP es: {####}. No comparta este código.',
        signUpEmailSubject: 'Su código de verificación de AIEP',
        signUpEmailBody: '<p>¡Bienvenido/a a AIEP!</p><p>Su código de verificación es: <strong>{####}</strong></p><p>Ingrese este código para verificar su correo electrónico.</p>',
        forgotPasswordEmailSubject: 'Restablezca su contraseña de AIEP',
        forgotPasswordEmailBody: '<p>Recibimos una solicitud para restablecer su contraseña de AIEP.</p><p>Su código para restablecer la contraseña es: <strong>{####}</strong></p><p>Si usted no solicitó esto, puede ignorar este correo.</p>'
    },
    zh: {
        otpLoginSms: '您的 The GovLab AIEP 登录验证码是：{code}。验证码 {minutes} 分钟内有效。请勿与他人分享。可能产生短信和数据费用。',
        verificationSms: '您的 The GovLab AIEP 验证码是：{####}。请勿与他人分享。可能产生短信和数据费用。',
        authenticationSms: '您的 The GovLab AIEP 登录验证码是：{####}。请勿与他人分享。',
        signUpEmailSubject: '您的 AIEP 验证码',
        signUpEmailBody: '<p>欢迎使用 AIEP！</p><p>您的验证码是：<strong>{####}</strong></p><p>请输入此验证码以验证您的电子邮箱。</p>',
        forgotPasswordEmailSubject: '重置您的 AIEP 密码',
        forgotPasswordEmailBody: '<p>我们收到了重置您 AIEP 密码的请求。</p><p>您的密码重置验证码是：<strong>{####}</strong></p><p>如果您没有提出此请求，请忽略此邮件。</p>'
    },
    vi: {
        otpLoginSms: 'Mã đăng nhập The GovLab AIEP của bạn là: {code}. Mã hết hạn sau {minutes} phút. Không chia sẻ mã này. Có thể áp dụng phí tin nhắn và dữ liệu.',
        verificationSms: 'Mã xác minh The GovLab AIEP của bạn là: {####}. Không chia sẻ mã này. Có thể áp dụng phí tin nhắn và dữ liệu.',
        authenticationSms: 'Mã đăng nhập The GovLab AIEP của bạn là: {####}. Không chia sẻ mã này.',
        signUpEmailSubject: 'Mã xác minh AIEP của bạn',
        signUpEmailBody: '<p>Chào mừng bạn đến với AIEP!</p><p>Mã xác minh của bạn là: <strong>{####}</strong></p><p>Nhập mã này để xác minh địa chỉ email của bạn.</p>',
        forgotPasswordEmailSubject: 'Đặt lại mật khẩu AIEP của bạn',
        forgotPasswordEmailBody: '<p>Chúng tôi đã nhận được yêu cầu đặt lại mật khẩu AIEP của bạn.</p><p>Mã đặt lại mật khẩu của bạn là: <strong>{####}</strong></p><p>Nếu bạn không yêu cầu điều này, bạn có thể bỏ qua email này.</p>'
    },
    ar: {
        otpLoginSms: 'رمز تسجيل الدخول إلى The GovLab AIEP هو: {code}. تنتهي صلاحية الرمز خلال {minutes} دقائق. لا تشارك هذا الرمز مع أحد. قد تُطبق رسوم الرسائل والبيانات.',
        verificationSms: 'رمز التحقق من The GovLab AIEP هو: {####}. لا تشارك هذا الرمز مع أحد. قد تُطبق رسوم الرسائل والبيانات.',
        authenticationSms: 'رمز تسجيل الدخول إلى The GovLab AIEP هو: {####}. لا تشارك هذا الرمز مع أحد.',
        signUpEmailSubject: 'رمز التحقق الخاص بك من AIEP',
        signUpEmailBody: '<div dir="rtl"><p>مرحبًا بك في AIEP!</p><p>رمز التحقق الخاص بك هو: <strong>{####}</strong></p><p>أدخل هذا الرمز للتحقق من بريدك الإلكتروني.</p></div>',
        forgotPasswordEmailSubject: 'إعادة تعيين كلمة مرور AIEP',
        forgotPasswordEmailBody: '<div dir="rtl"><p>تلقينا طلبًا لإعادة تعيين كلمة مرور AIEP الخاصة بك.</p><p>رمز إعادة تعيين كلمة المرور هو: <strong>{####}</strong></p><p>إذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة.</p></div>'
    }
};

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
            // secondaryLanguage is the UI language the app keeps in sync
            return normalizeLanguage(profile.secondaryLanguage)
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
    resolveLanguage
};

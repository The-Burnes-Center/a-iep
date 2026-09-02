import React, { useState } from 'react';
import {
  signIn, signUp, confirmSignIn, confirmSignUp, resendSignUpCode,
  resetPassword, confirmResetPassword, getCurrentUser,
} from 'aws-amplify/auth';

// Amplify v6 reports service errors on `name`; v5 used `code`. Read both so the
// branching below keeps working regardless of which the SDK surfaces.
const errCode = (e: unknown): string | undefined => {
  const err = e as { code?: string; name?: string } | null | undefined;
  return err?.code ?? err?.name;
};
import { useNavigate, useLocation } from 'react-router-dom';
import { 
  Form, 
  Button, 
  Alert, 
  Spinner,
} from 'react-bootstrap';
// Bootstrap CSS is managed at runtime by common/direction.ts (LTR/RTL swap) —
// do not import it statically anywhere or both builds load at once
import './CustomLogin.css'; // Import the custom CSS file
import { useLanguage, SupportedLanguage } from '../common/language-context';
import { LANGUAGES, filterEnabledOptions } from '../common/languages';
import { useAuth } from '../common/auth-provider';
import { cognitoErrorKey } from '../common/helpers/cognito-error-helper';
import AuthHeader from './AuthHeader';
import PasswordInput from './PasswordInput';
import PasswordRequirements from './PasswordRequirements';
import AlertMessages from './AlertMessages';
import SubmitButton from './SubmitButton';
import LinkButton from './LinkButton';
import EmailInput from './EmailInput';
import ForgotPassword from './ForgotPassword';
import LanguageDropdown from './LanguageDropdown';
import LoginMethodToggle from './LoginMethodToggle';
import FormLabel from './FormLabel';
import VerificationCodeInput from './VerificationCodeInput';

interface CustomLoginProps {
  showLogo?: boolean;
  showLanguageDropdown?: boolean;
}

/** The slice of the v6 signIn/confirmSignIn result the phone custom-auth flow reads back */
interface SmsChallengeUser {
  isSignedIn?: boolean;
  nextStep?: { signInStep?: string; additionalInfo?: Record<string, string> };
}

const CustomLogin: React.FC<CustomLoginProps> = ({ showLogo = true, showLanguageDropdown = false }) => {
  // Get translation function and language setter from context
  const { t, language, setLanguage, enabledLanguages } = useLanguage();
  
  // Get auth functions and navigation
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  
  // Existing state variables
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetCode, setResetCode] = useState('');
  const [resetEmail, setResetEmail] = useState('');
  const [resetSent, setResetSent] = useState(false);
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);
  
  // Sign up state variables
  const [showSignUp, setShowSignUp] = useState(false);
  const [signUpEmail, setSignUpEmail] = useState('');
  const [signUpPassword, setSignUpPassword] = useState('');
  const [signUpConfirmPassword, setSignUpConfirmPassword] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [isSignUpComplete, setIsSignUpComplete] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  
  // Mobile login state variables
  const [phoneNumber, setPhoneNumber] = useState('+1 ');
  const [showMobileLogin, setShowMobileLogin] = useState(true);  
  const [mobileLoading, setMobileLoading] = useState(false);
  const [smsCode, setSmsCode] = useState('');
  const [smsCodeSent, setSmsCodeSent] = useState(false);
  const [cognitoUserForSms, setCognitoUserForSms] = useState<SmsChallengeUser | null>(null);
  const [isNewUserConfirmation, setIsNewUserConfirmation] = useState(false); // Track if this is signup confirmation
  const [pendingPhoneNumber, setPendingPhoneNumber] = useState<string | null>(null);
  const [, setIsNewUserSignup] = useState(false); // Track if this is a brand new user signup // Store phone for confirmation flow
  
  // State for toggling password visibility
  const [showMainPassword, setShowMainPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [showSignUpPassword, setShowSignUpPassword] = useState(false);
  const [showSignUpConfirmPassword, setShowSignUpConfirmPassword] = useState(false);

  // Language options enabled for this environment
  const languageOptions = filterEnabledOptions(LANGUAGES, enabledLanguages);

  // Handle language change
  const handleLanguageChange = (lang: SupportedLanguage) => {
    setLanguage(lang);
  };

  // Handle successful authentication
  const handleSuccessfulAuthentication = () => {
    // console.log('User authentication successful');
    // Navigate to where user was trying to go, or default to /preferred-language
    // PreferredLanguage will handle onboarding decisions based on profile.showOnboarding
    const from = location.state?.from?.pathname || '/preferred-language';
    navigate(from, { replace: true });
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccessMessage(null);
    
    // Convert email to lowercase
    const normalizedUsername = username.toLowerCase();
    
    try {
      const { isSignedIn, nextStep } = await signIn({
        username: normalizedUsername,
        password,
        options: { clientMetadata: { language } },
      });
      // console.log('Login successful', user);
      
      // Check for NEW_PASSWORD_REQUIRED challenge
      // v6: challenges arrive as nextStep.signInStep, not user.challengeName.
      if (nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        // console.log('New password required');
        setPasswordChangeRequired(true);
        // v6 tracks the pending sign-in internally; only the flag is needed.
        setLoading(false);
        return;
      }
      
      // v6: signIn returns no user object — fetch it once signed in.
      if (isSignedIn) login(await getCurrentUser());
      handleSuccessfulAuthentication();
    } catch (err) {
      // console.error('Login error', err);
      setError(cognitoErrorKey(err, { NotAuthorizedException: 'auth.errorIncorrectCredentials' }));
    } finally {
      setLoading(false);
    }
  };

  /**
   * Sign in via the phone custom-auth flow, transparently answering the
   * backend's language-handshake round. Cognito doesn't forward sign-in
   * clientMetadata to the SMS lambda, so the backend's first challenge round
   * sends no SMS and just collects the UI language: answering it through
   * sendCustomChallengeAnswer DOES forward clientMetadata, and the next
   * round sends the OTP in that language.
   */
  const signInWithPhone = async (phone: string) => {
    // v6: CUSTOM_AUTH needs an explicit authFlowType; challenge metadata moves
    // from challengeParam to nextStep.additionalInfo.
    let user: SmsChallengeUser = await signIn({
      username: phone,
      options: { authFlowType: 'CUSTOM_WITHOUT_SRP', clientMetadata: { language } },
    });
    if (
      user.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE' &&
      user.nextStep?.additionalInfo?.challengeType === 'LANGUAGE_HANDSHAKE'
    ) {
      // confirmSignIn still forwards clientMetadata, preserving the two-round
      // language handshake the backend depends on.
      user = await confirmSignIn({
        challengeResponse: 'HANDSHAKE_ACK',
        options: { clientMetadata: { language } },
      });
    }
    return user;
  };

  /**
   * Route the outcome of a phone custom-auth sign-in: surface a failed SMS
   * send, park the user on the OTP screen, or complete the login.
   *
   * Extracted because three paths now need identical handling — an existing
   * user, a freshly auto-confirmed signup, and the UsernameExistsException
   * race — and a third hand-copy of it was where a divergence would hide.
   */
  const applyPhoneSignInResult = async (
    cognitoUser: Awaited<ReturnType<typeof signInWithPhone>>,
    sentMessageKey = 'auth.smsCodeSent'
  ) => {
    if (cognitoUser.nextStep?.signInStep !== 'CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE') {
      // v6: signIn returns no user object — fetch it once signed in.
      login(await getCurrentUser());
      handleSuccessfulAuthentication();
      return;
    }

    if (cognitoUser.nextStep?.additionalInfo?.error) {
      // The SMS lambda reports send failures through this challenge
      // parameter; without this check the UI claims a code was sent.
      setError('auth.errorSendingCode');
      return;
    }

    setCognitoUserForSms(cognitoUser);
    setSmsCodeSent(true);
    setIsNewUserConfirmation(false);
    setSuccessMessage(sentMessageKey);
  };

  /**
   * Clean Phone Authentication Flow (Frontend Only)
   * Handles both signup confirmation and custom auth properly
   */
  const handleMobileLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneNumber.trim()) {
      setError('auth.pleaseEnterPhoneNumber');
      return;
    }

    setMobileLoading(true);
    setError('');
    setSuccessMessage(null);

    // Extract only digits and format properly to E.164
    const digits = phoneNumber.replace(/\D/g, '');
    if (digits.length < 10) {
      setError('auth.errorPhoneFormat');
      setMobileLoading(false);
      return;
    }
    
    // Format as +1XXXXXXXXXX (E.164 format for US numbers)
    const formattedPhone = `+1${digits.slice(-10)}`;

    try {
      // console.log('Starting phone authentication for:', formattedPhone);
      // console.log('Current auth state - smsCodeSent:', smsCodeSent, 'isNewUserConfirmation:', isNewUserConfirmation);
      
      // Try custom auth first (for existing users)
      let cognitoUser;
      try {
        cognitoUser = await signInWithPhone(formattedPhone);
        // console.log('Existing user found, custom auth initiated');
        // console.log('SignIn result:', { challengeName: cognitoUser.challengeName, username: cognitoUser.username });
        
        // Handle the authentication response for existing users
        await applyPhoneSignInResult(cognitoUser);

      } catch (signInError) {
        // console.log('SignIn error:', signInError.code);

        // NotAuthorizedException is how "user does not exist" surfaces here:
        // the app client prevents user existence errors, so the define-auth
        // lambda fails auth for unknown numbers instead of Cognito throwing
        // UserNotFoundException. Treat both as "create the account".
        if (errCode(signInError) === 'UserNotFoundException' || errCode(signInError) === 'NotAuthorizedException') {
          // User doesn't exist, create them first
          // console.log('Creating new user for phone:', formattedPhone);
          
          // Generate a secure random password
          const tempPassword = 'TempPass123!' + Math.random().toString(36).substring(2, 15);
          
          try {
            // v6: attributes/clientMetadata move under options.
            const signUpResult = await signUp({
              username: formattedPhone,
              password: tempPassword,
              options: {
                userAttributes: {
                  phone_number: formattedPhone,
                  // 'locale' is how the OTP login SMS gets localized: Cognito
                  // doesn't forward sign-in clientMetadata to that trigger
                  locale: language,
                },
                clientMetadata: { language },
              },
            });

            // v6 renamed userConfirmed -> isSignUpComplete
            if (signUpResult.isSignUpComplete) {
              // The PreSignUp trigger auto-confirmed the account, so Cognito
              // minted no signup code and there is nothing to collect here:
              // go straight to the login OTP, which is now the ONLY SMS a new
              // parent receives.
              setIsNewUserSignup(true);
              await applyPhoneSignInResult(await signInWithPhone(formattedPhone), 'auth.smsCodeSentNewUser');
            } else {
              // userConfirmed === false means the trigger did not take effect.
              // Fall back to the old two-code flow rather than stranding the
              // parent on a screen waiting for a code that never comes.
              setIsNewUserConfirmation(true);
              setPendingPhoneNumber(formattedPhone);
              setIsNewUserSignup(true); // Mark as new user signup
              setSmsCodeSent(true);
              setSuccessMessage('auth.smsCodeSentNewUser');
            }

          } catch (signUpError) {
            // console.error('SignUp error:', signUpError);
            if (errCode(signUpError) === 'UsernameExistsException') {
              // User was created between our attempts, try signin again
              await applyPhoneSignInResult(await signInWithPhone(formattedPhone));
            } else {
              throw signUpError;
            }
          }
        } else if (errCode(signInError) === 'UserNotConfirmedException') {
          // User exists but not confirmed - treat as new user confirmation
          // console.log('User exists but not confirmed, setting up confirmation flow');
          
          // Try to resend confirmation code for existing unconfirmed user
          try {
            await resendSignUpCode({ username: formattedPhone, options: { clientMetadata: { language } } });
            // console.log('Resent confirmation code for existing user');
          } catch (resendError) {
            // console.log('Could not resend confirmation code:', resendError.code);
            // Continue anyway - user might still have valid code
          }
          
          setIsNewUserConfirmation(true);
          setPendingPhoneNumber(formattedPhone);
          setSmsCodeSent(true);
          setSuccessMessage('auth.phoneAccountConfirmPrompt');
        } else {
          throw signInError;
        }
      }
      
    } catch (error) {
      // console.error('Phone authentication error:', error);
      
      // In this flow InvalidParameterException means the phone number was
      // rejected, so it gets the phone-specific message
      setError(cognitoErrorKey(error, {
        NotAuthorizedException: 'auth.errorGeneric',
        InvalidParameterException: 'auth.errorPhoneFormat',
      }));
    } finally {
      setMobileLoading(false);
    }
  };

  /**
   * Handle SMS Code Verification (Frontend Only)
   * Handles both signup confirmation and custom auth challenges
   */
  const handleSmsCodeVerification = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!smsCode.trim() || smsCode.length !== 6) {
      setError('auth.pleaseEnterSmsCode');
      return;
    }

    setLoading(true);
    setError('');
    setSuccessMessage(null);

    try {
      // console.log('Verifying SMS code:', smsCode);
      // console.log('Is new user confirmation:', isNewUserConfirmation);
      // console.log('Pending phone number:', pendingPhoneNumber);
      // console.log('Cognito user for SMS:', cognitoUserForSms ? 'Present' : 'Null');
      
      if (isNewUserConfirmation) {
        // This is a signup confirmation
        if (!pendingPhoneNumber) {
          setError('auth.errorSessionExpired');
          setSmsCodeSent(false);
          setLoading(false);
          return;
        }
        
        // console.log('Confirming signup for:', pendingPhoneNumber);
        
        // Confirm the signup
        await confirmSignUp({ username: pendingPhoneNumber, confirmationCode: smsCode });
        // console.log('Signup confirmed successfully');
        
        // Now initiate custom auth for the confirmed user
        // console.log('Starting custom auth after confirmation');
        
        try {
          const cognitoUser = await signInWithPhone(pendingPhoneNumber);

          if (cognitoUser.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE' && !cognitoUser.nextStep?.additionalInfo?.error) {
            // Switch to custom auth mode
            setCognitoUserForSms(cognitoUser);
            setIsNewUserConfirmation(false);
            setPendingPhoneNumber(null);
            setSmsCode(''); // Clear the confirmation code
            setSuccessMessage('auth.accountConfirmedNewCode');
            // console.log('Custom auth initiated after confirmation');
          } else if (cognitoUser.isSignedIn) {
            // User is fully authenticated (shouldn't happen with CUSTOM_AUTH but handle gracefully)
            // console.log('User authenticated successfully after confirmation');
            setSuccessMessage('auth.accountConfirmedSuccess');
            
            // Update auth context with logged in user
            // v6: the result carries only status — fetch the real user.
            login(await getCurrentUser());
            
            setTimeout(() => {
              handleSuccessfulAuthentication();
            }, 1000);
          } else {
            // console.error('Unexpected auth state after confirmation:', cognitoUser);
            setError('auth.errorGeneric');
            // Reset to phone input
            setSmsCodeSent(false);
            setIsNewUserConfirmation(false);
            setPendingPhoneNumber(null);
            setSmsCode('');
          }
        } catch (postConfirmError) {
          // console.error('Error starting custom auth after confirmation:', postConfirmError);
          if (errCode(postConfirmError) === 'UserNotConfirmedException') {
            setError('auth.errorVerification');
          } else {
            setError('auth.errorGeneric');
          }
          // Reset to phone input
          setSmsCodeSent(false);
          setIsNewUserConfirmation(false);
          setPendingPhoneNumber(null);
          setSmsCode('');
          setIsNewUserSignup(false);
        }
        
      } else {
        // This is a custom auth challenge
        if (!cognitoUserForSms) {
          setError('auth.errorSessionExpired');
          setSmsCodeSent(false);
          setLoading(false);
          return;
        }
        
        // console.log('Verifying custom auth challenge');
        
        // Send the challenge response
        // v6: the pending sign-in is tracked internally — no user object is passed.
        const result: SmsChallengeUser = await confirmSignIn({
          challengeResponse: smsCode,
          options: { clientMetadata: { language } },
        });
        
        // console.log('Challenge response result:', result);
        
        // Check if authentication is complete
        if (result.isSignedIn) {
          // console.log('Authentication successful!');
          setSuccessMessage('auth.phoneVerificationSuccess');
          
          // Update auth context with logged in user
          // v6: the result carries only status — fetch the real user.
          login(await getCurrentUser());
          
          // Small delay to show success message, then redirect
          setTimeout(() => {
            handleSuccessfulAuthentication();
          }, 1000);
          
        } else if (result.nextStep?.signInStep) {
          // Still have challenges to complete
          // console.log('Additional challenge required:', result.challengeName);
          setCognitoUserForSms(result);
          setError('auth.errorGeneric');

        } else {
          // Unexpected state
          // console.error('Unexpected auth state:', result);
          setError('auth.errorGeneric');
        }
      }
      
    } catch (error) {
      // console.error('SMS verification error:', error);
      
      // Handle specific error cases. The message check catches custom-auth
      // lambdas that report a wrong code as NotAuthorized/"Incorrect ...".
      if (errCode(error) === 'NotAuthorizedException' || error.message?.includes('Incorrect')) {
        setError('auth.invalidSmsCode');
      } else {
        setError(cognitoErrorKey(error, {
          CodeMismatchException: 'auth.invalidSmsCode',
          ExpiredCodeException: 'auth.expiredSmsCode',
        }));
      }
      
      // Clear the SMS code on error
      setSmsCode('');
      
    } finally {
      setLoading(false);
    }
  };

  /**
   * Resend SMS Code (Frontend Only)
   * Handles both signup confirmation resend and custom auth resend
   */
  const handleResendSmsCode = async () => {
    setLoading(true);
    setError('');
    setSuccessMessage(null);

    try {
      // console.log('Resending SMS code');
      // console.log('Is new user confirmation:', isNewUserConfirmation);
      
      if (isNewUserConfirmation) {
        // Resend signup confirmation code
        if (!pendingPhoneNumber) {
          setError('auth.errorSessionExpired');
          setSmsCodeSent(false);
          setLoading(false);
          return;
        }
        
        // console.log('Resending signup confirmation for:', pendingPhoneNumber);
        await resendSignUpCode({ username: pendingPhoneNumber, options: { clientMetadata: { language } } });
        setSuccessMessage('auth.smsCodeResent');
        setSmsCode(''); // Clear previous code
        
      } else {
        // Resend custom auth challenge
        if (!cognitoUserForSms) {
          setError('auth.errorSessionExpired');
          setSmsCodeSent(false);
          setLoading(false);
          return;
        }
        
        // console.log('Resending custom auth challenge');
        
        // For custom auth, we need to re-initiate the auth flow to get a new challenge
        // Instead of using sendCustomChallengeAnswer with 'RESEND', we restart the flow
        try {
          // v6: the sign-in result carries no username, so re-derive the E.164
          // number from the form state (same formatting as sign-in).
          const resendDigits = phoneNumber.replace(/\D/g, '');
          const phoneNumberForResend = resendDigits.length >= 10 ? `+1${resendDigits.slice(-10)}` : null;
          if (!phoneNumberForResend) {
            setError('auth.errorSessionExpired');
            setSmsCodeSent(false);
            setLoading(false);
            return;
          }

          const result = await signInWithPhone(phoneNumberForResend);

          if (result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE' && !result.nextStep?.additionalInfo?.error) {
            setCognitoUserForSms(result);
            setSuccessMessage('auth.smsCodeResent');
            setSmsCode(''); // Clear previous code
          } else {
            setError('auth.errorResendCode');
          }
        } catch (resendError) {
          // console.error('Resend custom auth error:', resendError);
          setError(cognitoErrorKey(resendError, undefined, 'auth.errorResendCode'));
        }
      }
      
    } catch (error) {
      // console.error('Resend SMS error:', error);
      setError(cognitoErrorKey(error, undefined, 'auth.errorResendCode'));
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (newPassword !== confirmPassword) {
      setError('auth.errorPasswordsNotMatch');
      return;
    }
    
    setLoading(true);
    setError(null);
    
    try {
      // Complete the new password challenge
      // v6: the NEW_PASSWORD_REQUIRED challenge is answered via confirmSignIn.
      const { isSignedIn } = await confirmSignIn({ challengeResponse: newPassword });

      if (isSignedIn) login(await getCurrentUser());
      
      // Navigate to appropriate page
      handleSuccessfulAuthentication();
    } catch (err) {
      // console.error('Password change error', err);
      setError(cognitoErrorKey(err));
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      await resetPassword({ username: resetEmail.toLowerCase(), options: { clientMetadata: { language } } });
      setResetSent(true);
      setSuccessMessage('auth.resetCodeSent');
    } catch (err) {
      // console.error('Forgot password error', err);
      setError(cognitoErrorKey(err));
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      setError('auth.errorPasswordsNotMatch');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      await confirmResetPassword({
        username: resetEmail.toLowerCase(),
        confirmationCode: resetCode,
        newPassword,
      });
      setSuccessMessage('auth.passwordResetSuccess');
      setShowForgotPassword(false);
      setResetSent(false);
      setResetCode('');
      setResetEmail('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      // console.error('Reset password error', err);
      setError(cognitoErrorKey(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (signUpPassword !== signUpConfirmPassword) {
      setError('auth.errorPasswordsNotMatch');
      return;
    }
    
    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      await signUp({
        username: signUpEmail.toLowerCase(),
        password: signUpPassword,
        options: {
          userAttributes: { email: signUpEmail.toLowerCase(), locale: language },
          clientMetadata: { language },
        },
      });
      
      // console.log('Sign up successful', user);
      setIsSignUpComplete(true);
      setSuccessMessage('auth.signUpSuccess');
    } catch (err) {
      // console.error('Sign up error', err);
      setError(cognitoErrorKey(err));
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      await confirmSignUp({ username: signUpEmail.toLowerCase(), confirmationCode: verificationCode });
      setSuccessMessage('auth.emailVerified');
      setShowSignUp(false);
      setIsSignUpComplete(false);
      setSignUpEmail('');
      setSignUpPassword('');
      setSignUpConfirmPassword('');
      setVerificationCode('');
    } catch (err) {
      // console.error('Confirm sign up error', err);
      setError(cognitoErrorKey(err));
    } finally {
      setLoading(false);
    }
  };

  const handleResendConfirmation = async () => {
    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      await resendSignUpCode({ username: signUpEmail.toLowerCase(), options: { clientMetadata: { language } } });
      setSuccessMessage('auth.verificationCodeResent');
    } catch (err) {
      // console.error('Resend confirmation error', err);
      setError(cognitoErrorKey(err, undefined, 'auth.errorResendCode'));
    } finally {
      setLoading(false);
    }
  };

  // Show password change form if required
  if (passwordChangeRequired) {
    return (
      <>
        {showLanguageDropdown && (
          <div className="auth-mobile-language-dropdown">
            <LanguageDropdown 
              language={language}
              languageOptions={languageOptions}
              onLanguageChange={handleLanguageChange}
              variant="secondary"
            />
          </div>
        )}
        <AuthHeader title={t('auth.changePassword')} showLogo={showLogo} />
        
        <Form onSubmit={handleCompleteNewPassword}>
          <PasswordInput
            label={t('auth.newPassword')}
            placeholder={t('auth.enterNewPassword')}
            value={newPassword}
            onChange={setNewPassword}
            showPassword={showNewPassword}
            onToggleVisibility={() => setShowNewPassword(!showNewPassword)}
            required
          />

          <PasswordRequirements 
            title={t('auth.passwordRequirements')}
            firstRequirement={t('auth.passwordRequirement1')}
            secondRequirement={t('auth.passwordRequirement2')}
          />
          
          <PasswordInput
            label={t('auth.passwordConfirm')}
            placeholder={t('auth.passwordConfirm')}
            value={confirmPassword}
            onChange={setConfirmPassword}
            showPassword={showConfirmPassword}
            onToggleVisibility={() => setShowConfirmPassword(!showConfirmPassword)}
            required
          />

          {error && <Alert variant="danger">{error}</Alert>}
          
          <div className="d-grid gap-2">
              <SubmitButton 
                loading={loading}
                buttonText={t('auth.changePassword')}
              />              
          </div>
        </Form>
      </>
    );
  }

  // Show forgot password form
  if (showForgotPassword) {
    return (
      <>
        {showLanguageDropdown && (
          <div className="auth-mobile-language-dropdown">
            <LanguageDropdown 
              language={language}
              languageOptions={languageOptions}
              onLanguageChange={handleLanguageChange}
              variant="secondary"
            />
          </div>
        )}
        <ForgotPassword
          t={t}
          loading={loading}
          error={error}
          successMessage={successMessage}
          resetSent={resetSent}
          resetEmail={resetEmail}
          resetCode={resetCode}
          newPassword={newPassword}
          confirmPassword={confirmPassword}
          showNewPassword={showNewPassword}
          showConfirmPassword={showConfirmPassword}
          showLogo={showLogo}
          setResetEmail={setResetEmail}
          setResetCode={setResetCode}
          setNewPassword={setNewPassword}
          setConfirmPassword={setConfirmPassword}
          setShowNewPassword={setShowNewPassword}
          setShowConfirmPassword={setShowConfirmPassword}
          setShowForgotPassword={setShowForgotPassword}
          setResetSent={setResetSent}
          handleForgotPassword={handleForgotPassword}
          handleResetPassword={handleResetPassword}
        />
      </>
    );
  }

  // Show sign up form
  if (showSignUp) {
    return (
      <>
        {showLanguageDropdown && (
          <div className="auth-mobile-language-dropdown">
            <LanguageDropdown 
              language={language}
              languageOptions={languageOptions}
              onLanguageChange={handleLanguageChange}
              variant="secondary"
            />
          </div>
        )}
        <AuthHeader title={isSignUpComplete ? t('auth.verifyEmail') : t('auth.signUp')} showLogo={showLogo} />
          
          {!isSignUpComplete ? (
            <Form onSubmit={handleSignUp}>
              <EmailInput
                label={t('auth.email')}
                placeholder={t('auth.enterEmail')}
                value={signUpEmail}
                onChange={setSignUpEmail}
              />
              
              <PasswordInput
                label={t('auth.password')}
                placeholder={t('auth.enterPassword')}
                value={signUpPassword}
                onChange={setSignUpPassword}
                showPassword={showSignUpPassword}
                onToggleVisibility={() => setShowSignUpPassword(!showSignUpPassword)}
                required
              />
              
              <PasswordInput
                label={t('auth.passwordConfirm')}
                placeholder={t('auth.passwordConfirm')}
                value={signUpConfirmPassword}
                onChange={setSignUpConfirmPassword}
                showPassword={showSignUpConfirmPassword}
                onToggleVisibility={() => setShowSignUpConfirmPassword(!showSignUpConfirmPassword)}
                required
              />

              <PasswordRequirements 
                title={t('auth.passwordRequirements')}
                firstRequirement={t('auth.passwordRequirement1')}
                secondRequirement={t('auth.passwordRequirement2')}
              />
              
              <AlertMessages error={error} successMessage={successMessage} />
              
              <div className="d-grid gap-2">
                  <SubmitButton 
                    loading={loading}
                    buttonText={t('auth.signUp')}
                  />
                <LinkButton
                  onClick={() => {
                    setShowSignUp(false);
                    setError(null);
                    setSuccessMessage(null);
                  }}
                  disabled={loading}
                  buttonText={t('auth.backToLogin')}
                />
              </div>
            </Form>
          ) : (
            <Form onSubmit={handleConfirmSignUp}>
              <Alert variant="info">{t('auth.checkEmailForCode')}</Alert>
              
              <Form.Group className="mb-3">
                <FormLabel label={t('auth.verificationCode')} />
                <Form.Control
                  type="text"
                  placeholder={t('auth.enterVerificationCode')}
                  value={verificationCode}
                  onChange={(e) => setVerificationCode(e.target.value)}
                  required
                />
              </Form.Group>
              
              <AlertMessages error={error} successMessage={successMessage} />
              
              <div className="d-grid gap-2">
                  <SubmitButton 
                    loading={loading}
                    buttonText={t('auth.verify')}
                  />
                <LinkButton
                  onClick={handleResendConfirmation}
                  disabled={loading}
                  buttonText={t('auth.resendCode')}
                />
                <LinkButton
                  onClick={() => {
                    setShowSignUp(false);
                    setIsSignUpComplete(false);
                    setError(null);
                    setSuccessMessage(null);
                  }}
                  disabled={loading}
                  buttonText={t('auth.backToLogin')}
                />
              </div>
            </Form>
          )}
      </>
    );
  }

  // Main login form with mobile login option
  return (
    <>
      {showLanguageDropdown && (
        <div className="auth-mobile-language-dropdown">
          <LanguageDropdown 
            language={language}
            languageOptions={languageOptions}
            onLanguageChange={handleLanguageChange}
            variant="secondary"
          />
        </div>
      )}
      <AuthHeader title={t('auth.signInHeader')} showLogo={showLogo} />

      <LoginMethodToggle
        showMobileLogin={showMobileLogin}
        onMobileLoginClick={() => setShowMobileLogin(true)}
        onEmailLoginClick={() => setShowMobileLogin(false)}
        mobileLoginText={t('auth.mobileLogin')}
        emailLoginText={t('auth.emailLogin')}
      />
        
        {showMobileLogin ? (
          // Mobile Login Form
          smsCodeSent ? (
            // SMS Verification Form
            <Form onSubmit={handleSmsCodeVerification}>
              <div className="mobile-form-container">
                <div className="sms-verification-info">
                  <p>
                    {t('auth.smsCodeSentTo')}<br />
                    {/* Phone numbers must always render left-to-right, even in RTL UI */}
                    <span className="phone-display" dir="ltr">{phoneNumber}</span>
                  </p>
                </div>
                <VerificationCodeInput
                  label={t('auth.verificationCodeSms')}
                  placeholder={t('auth.enterSmsCode')}
                  value={smsCode}
                  onChange={setSmsCode}
                  required
                  autoFocus
                />
                
                <AlertMessages error={error} successMessage={successMessage} />
                
                <div className="d-grid gap-2">
                    <SubmitButton 
                      loading={loading}
                      buttonText={t('auth.verifySmsCode')}
                      disabled={loading || smsCode.length !== 6}
                    />
                  <Button 
                    variant="outline-secondary"
                    onClick={handleResendSmsCode}
                    disabled={loading}
                    className="button-text"
                  >
                    {loading ? <Spinner animation="border" size="sm" /> : t('auth.resendSmsCode')}
                  </Button>
                  <LinkButton
                    onClick={() => {
                      setSmsCodeSent(false);
                      setCognitoUserForSms(null);
                      setSmsCode('');
                      setPhoneNumber('+1 ');
                      setError(null);
                      setSuccessMessage(null);
                      setIsNewUserConfirmation(false);
                      setPendingPhoneNumber(null);
                      setIsNewUserSignup(false);
                    }}
                    disabled={loading}
                    buttonText={t('auth.backToLogin')}
                  />
                </div>
              </div>
            </Form>
          ) : (
            // Phone Number Input Form
            <Form onSubmit={handleMobileLogin}>
              <div className="mobile-form-container">
                <Form.Group className="mb-3">
                  <FormLabel label={t('auth.phoneNumber')} />
                  <Form.Control
                    type="tel"
                    placeholder="(xxx) xxx-xxxx"
                    value={phoneNumber}
                    onChange={(e) => {
                      const input = e.target.value;
                      
                      // If input is shorter than "+1 ", reset to "+1 "
                      if (input.length < 3) {
                        setPhoneNumber('+1 ');
                        return;
                      }
                      
                      // Always keep +1 prefix
                      if (!input.startsWith('+1 ')) {
                        // Extract only digits from input
                        const digits = input.replace(/\D/g, '');
                        // Format as +1 (xxx) xxx-xxxx
                        let formatted = '+1 ';
                        if (digits.length > 0) {
                          if (digits.length <= 3) {
                            formatted += `(${digits}`;
                          } else if (digits.length <= 6) {
                            formatted += `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
                          } else {
                            formatted += `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
                          }
                        }
                        setPhoneNumber(formatted);
                      } else {
                        // Handle input that already has +1 prefix
                        const withoutPrefix = input.slice(3);
                        const digits = withoutPrefix.replace(/\D/g, '');
                        let formatted = '+1 ';
                        if (digits.length > 0) {
                          if (digits.length <= 3) {
                            formatted += `(${digits}`;
                          } else if (digits.length <= 6) {
                            formatted += `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
                          } else {
                            formatted += `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
                          }
                        }
                        setPhoneNumber(formatted);
                      }
                    }}
                    onKeyDown={(e) => {
                      // Prevent cursor movement before "+1 "
                      const target = e.target as HTMLInputElement;
                      if ((e.key === 'ArrowLeft' || e.key === 'Home') && target.selectionStart !== null && target.selectionStart <= 3) {
                        e.preventDefault();
                        target.setSelectionRange(3, 3);
                      }
                    }}
                    onClick={(e) => {
                      // Prevent cursor placement before "+1 "
                      const target = e.target as HTMLInputElement;
                      if (target.selectionStart !== null && target.selectionStart < 3) {
                        target.setSelectionRange(3, 3);
                      }
                    }}
                    onFocus={(e) => {
                      // Set cursor after "+1 " on focus
                      const target = e.target as HTMLInputElement;
                      setTimeout(() => {
                        if (target.selectionStart !== null && target.selectionStart < 3) {
                          target.setSelectionRange(3, 3);
                        }
                      }, 0);
                    }}
                    required
                    className='mobile-input'
                  />
                </Form.Group>
                
                <AlertMessages error={error} successMessage={successMessage} />
                
                <div className="d-grid gap-2">
                    <SubmitButton 
                      loading={mobileLoading}
                      buttonText={t('auth.sendSmsCode')}
                    />
                  
                  <p className="text-muted mt-3 mobile-consent-text">
                    {t('auth.smsConsentMobile')}
                  </p>
                </div>
              </div>
            </Form>
          )
        ) : (
          // Email Login Form
          <Form onSubmit={handleSignIn}>
            <div className="email-form-container">
              <EmailInput
                label={t('auth.email')}
                placeholder={t('auth.enterEmail')}
                value={username}
                onChange={setUsername}
              />
              
              <PasswordInput
                label={t('auth.password')}
                placeholder={t('auth.enterPassword')}
                value={password}
                onChange={setPassword}
                showPassword={showMainPassword}
                onToggleVisibility={() => setShowMainPassword(!showMainPassword)}
                required
              />
              
              <AlertMessages error={error} successMessage={successMessage} />
              
              <div className="d-grid gap-2">
                  <SubmitButton 
                    loading={loading}
                    buttonText={t('auth.signIn')}
                  />
                <div className="d-flex justify-content-between">
                  <LinkButton
                    onClick={() => setShowForgotPassword(true)}
                    disabled={loading}
                    buttonText={t('auth.forgotPassword')}
                  />
                  <LinkButton
                    onClick={() => {
                      setShowSignUp(true);
                      setError(null);
                      setSuccessMessage(null);
                    }}
                    disabled={loading}
                    buttonText={t('auth.signUp')}
                  />
                </div>

                <p className="text-muted mt-3" style={{ fontSize: '0.8rem', textAlign: 'center' }}>
                  {t('auth.smsConsent')}
                </p>
              </div>
            </div>
          </Form>
        )}
      
    </>
  );
};

export default CustomLogin;
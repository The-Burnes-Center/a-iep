import React from 'react';
import { useAuth } from '../../common/auth-provider';
import { signOut } from 'aws-amplify/auth';
import { useNavigate } from 'react-router-dom';
import MobileTopNavigation from '../../components/MobileTopNavigation';
import AIEPFooter from '../../components/AIEPFooter';
import { Container, Row, Col, Card, Accordion, Spinner} from 'react-bootstrap';
import { useLanguage } from '../../common/language-context';
import { useAdminIdentity } from '../../common/helpers/use-admin-identity';
import { useFeatures } from '../../common/hooks/use-features';
import { IconArrowRight, IconLogout } from '@tabler/icons-react';
import './AccountCenter.css';

const AccountCenter: React.FC = () => {

  const { t, translationsLoaded } = useLanguage();
  const { setAuthenticated } = useAuth();
  const { isAdmin } = useAdminIdentity();
  const { isFeatureEnabled } = useFeatures();
  const navigate = useNavigate();

  // Return loading state if translations aren't ready
  if (!translationsLoaded) {
    return (
      <Container className="account-center-container mt-4 mb-5">
        <div className="text-center my-5">
          <Spinner animation="border" role="status">
            <span className="visually-hidden">Loading...</span>
          </Spinner>        
        </div>
      </Container>
    );
  }

  const handleSignOut = async () => {
    try {
      navigate('/', { replace: true });
      await signOut();
      setAuthenticated(false);
    } catch (error) {
      // console.error("Error signing out:", error);
    }
  };

  // Navigation handler for accordion items
  const handleAccordionClick = (id: string) => {
    switch (id) {
      case '0':
        navigate('/account-center/profile');
        break;
      case '1':
        navigate('/account-center/change-language');
        break;
      case '2':
        navigate('/account-center/delete-account');
        break;
      case '3':
        navigate('/invite');
        break;
      case '4':
        handleSignOut();
        break;
      case '5':
        navigate('/admin/referrals');
        break;
      default:
        break;
    }
  };

  // FAQ data object.
  // testId is the stable, language-independent hook the E2E suite navigates
  // by (every visible title here is localized).
  const headers = [
    {
      id: "0",
      title: t("accountCenter.updateProfile"),
      testId: "account-center-update-profile",
    },
    {
      id: "1",
      title: t("accountCenter.changeLanguage"),
      testId: "account-center-change-language",
    },
    // The only in-app entry point to the referral flow, so this row is what
    // keeps referrals dark where the feature is off (prod). The /invite route
    // itself stays registered, and the ?ref= capture keeps running: neither is
    // reachable by a parent while no codes are issued. See common/features.ts.
    ...(isFeatureEnabled('referrals')
      ? [{
          id: "3",
          title: t("invite.title"),
          testId: "account-center-invite",
        }]
      : []),
    // Internal console entry, rendered only for members of the Cognito
    // admin group (the backend re-checks the claim on every admin API call).
    // The console it opens is English-only by design; this row is not, because
    // it sits in a list a parent reads in their own language.
    ...(isAdmin ? [{ id: "5", title: t("accountCenter.adminConsole"), testId: "account-center-admin-console" }] : []),
    // Deliberately last but one, directly above Log out. Deleting an account
    // is irreversible and it used to sit above the everyday rows, where a
    // mistap costs a parent their documents. Ids are unchanged so the E2E
    // hooks and any stored accordion state still resolve.
    {
      id: "2",
      title: t("accountCenter.deleteAccount"),
      testId: "account-center-delete-account",
    },
    {
      id: "4",
      title: t("accountCenter.logOut"),
      testId: "account-center-log-out",
    }
  ];

  return (
    <>
      <MobileTopNavigation />
      <Container className="account-center-container mt-3 mb-3">
        <Row className="mt-2">
          <Col>
            <Card className="account-center-card">
              <Row className="g-0">
                <Col md={12} className="no-padding-inherit-faq">
                  <>
                    <h4 className="account-center-header mt-4 px-4">{t("accountCenter.title")}</h4>
                    {/* Add some text to this page about what the account center does */}
                    <Accordion className="account-center-accordion">
                      {headers.map((header) => (
                        <Accordion.Item key={header.id} eventKey={header.id}>
                          <Accordion.Header
                            data-testid={header.testId}
                            onClick={() => handleAccordionClick(header.id)}
                            style={{ cursor: 'pointer' }}
                          >
                            <span className="accordion-title-content">
                              {header.title}
                              {header.id === '4' ? (
                                <IconLogout size={18} stroke={2} className="accordion-icon logout-icon" />
                              ) : (
                                <IconArrowRight size={18} stroke={2} className="accordion-icon arrow-icon" />
                              )}
                            </span>
                          </Accordion.Header>
                        </Accordion.Item>
                      ))}
                    </Accordion>
                  </>
                </Col>
              </Row>
            </Card>
          </Col>
        </Row>
      </Container>
      <AIEPFooter />
    </>
  );
};

export default AccountCenter;
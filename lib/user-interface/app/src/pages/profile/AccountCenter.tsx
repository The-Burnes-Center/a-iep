import React from 'react';
import { useAuth } from '../../common/auth-provider';
import { Auth } from "aws-amplify";
import { useNavigate } from 'react-router-dom';
import MobileTopNavigation from '../../components/MobileTopNavigation';
import AIEPFooter from '../../components/AIEPFooter';
import { Container, Row, Col, Card, Accordion, Spinner} from 'react-bootstrap';
import { useLanguage } from '../../common/language-context';
import { IconArrowRight, IconLogout } from '@tabler/icons-react';
import './AccountCenter.css';

const AccountCenter: React.FC = () => {

  const { t, translationsLoaded } = useLanguage();
  const { setAuthenticated } = useAuth();
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
      await Auth.signOut();
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
      default:
        break;
    }
  };

  // FAQ data object
  const headers = [
    {
      id: "0",
      title: t("accountCenter.updateProfile"),
    },
    {
      id: "1",
      title: t("accountCenter.changeLanguage"),
    },
    {
      id: "2",
      title: t("accountCenter.deleteAccount"),
    },
    {
      id: "3",
      title: t("invite.title"),
    },
    {
      id: "4",
      title: t("accountCenter.logOut"),
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
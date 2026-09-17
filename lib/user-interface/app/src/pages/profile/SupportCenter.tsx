import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Container, Row, Col, Card, Accordion } from 'react-bootstrap';
import PageLoading from '../../components/PageLoading';
import { useLanguage } from '../../common/language-context';
import { IconArrowRight } from '@tabler/icons-react';
import LanguagePreferenceDropdown from '../../components/LanguagePreferenceDropdown';
import './AccountCenter.css';

interface SupportCenterProps {
  showAboutApp?: boolean;
}

const SupportCenter: React.FC<SupportCenterProps> = ({ 
  showAboutApp = true 
}) => {

  const { t, translationsLoaded } = useLanguage();

  const navigate = useNavigate();

  // Return loading state if translations aren't ready
  if (!translationsLoaded) {
    return (
      <PageLoading message={t('common.loading')} />
    );
  }

  // Navigation handler for accordion items
  const handleAccordionClick = (id: string) => {
    switch (id) {
      case '0':
        navigate('/frequently-asked-questions');
        break;
      case '1':
        navigate('/view-resources');
        break;
      case '2':
        navigate('/about-the-app');
        break;
      default:
        break;
    }
  };

  // Build headers array conditionally
  const headers = [
    {
      id: "0",
      title: t("supportCenter.frequentlyAskedQuestions"),
    },
    {
      id: "1",
      title: t("supportCenter.resources"), 
    },
    ...(showAboutApp ? [{
      id: "2",
      title: t("supportCenter.aboutTheApp"),
    }] : []),
  ];

  return (
    <>
      <Container className="account-center-container mt-3 mb-3">
        <Row className="mt-2">
          <Col>
            <LanguagePreferenceDropdown />
            <Card className="account-center-card">
              <Row className="g-0">
                <Col md={12} className="no-padding-inherit-faq">
                  <>
                    <h4 className="account-center-header mt-4 px-4">{t("supportCenter.title")}</h4>
                    <Accordion className="support-center-accordion">
                      {headers.map((header) => (
                        <Accordion.Item key={header.id} eventKey={header.id}>
                          <Accordion.Header 
                            onClick={() => handleAccordionClick(header.id)}
                            style={{ cursor: 'pointer' }}
                          >
                            <span className="accordion-title-content">
                              {header.title}
                              <IconArrowRight size={18} stroke={2} className="accordion-icon arrow-icon" />
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
    </>
  );
};

export default SupportCenter;
import React, { useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Container, Row, Col, Card, Accordion, Button } from 'react-bootstrap';
import PageLoading from '../../components/PageLoading';
import { useLanguage } from '../../common/language-context';
import { AppContext } from '../../common/app-context';
import { IEPDocumentClient } from '../../common/api-client/iep-document-client';
import { REPLAY_TOUR_STATE_KEY } from '../iep-folder/summary-tour';
import { IconArrowRight } from '@tabler/icons-react';
import './AccountCenter.css';

interface SupportCenterProps {
  showAboutApp?: boolean;
}

const SupportCenter: React.FC<SupportCenterProps> = ({ 
  showAboutApp = true 
}) => {

  const { t, translationsLoaded } = useLanguage();

  const navigate = useNavigate();

  // The tour points at a finished summary, so "Show me around" is only offered
  // to a parent who has one. Nothing on this page knows that, so it asks the
  // documents endpoint once (the answer is cached for a minute). Until it
  // answers, and if it fails, the button is simply not there: a button that
  // lands a parent on the upload page instead of a tour is worse than none.
  const appContext = useContext(AppContext);
  const { data: hasSummary = false } = useQuery({
    queryKey: ['has-processed-summary'],
    queryFn: async () => {
      const latest = await new IEPDocumentClient(appContext).getMostRecentDocumentWithSummary();
      const hasText = (value: unknown) => typeof value === 'string' && value.length > 0;
      return (
        latest?.status === 'PROCESSED' &&
        (hasText(latest.summaries?.en) || (latest.sections?.en?.length ?? 0) > 0)
      );
    },
    staleTime: 60_000,
    retry: false,
  });

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
                    {hasSummary && (
                      <div className="px-4 pb-4 pt-3">
                        <Button
                          variant="primary"
                          onClick={() => navigate('/summary-and-translations', { state: { [REPLAY_TOUR_STATE_KEY]: true } })}
                          data-testid="show-me-around"
                        >
                          {t('supportCenter.showMeAround')}
                        </Button>
                      </div>
                    )}
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
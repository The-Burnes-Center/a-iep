import React, { useMemo } from 'react';
import { Container, Row, Col, Card, Accordion } from 'react-bootstrap';
import PageLoading from '../components/PageLoading';
import '../components/FrequentlyAskedQuestions.css';
import { useLanguage } from '../common/language-context'; 


const ParentRights: React.FC = () => {
   const { t, translationsLoaded } = useLanguage();

   // Parent rights data using same translation keys as parentRightsSlideData
   const rightsByLanguage = useMemo(() => {
     if (!translationsLoaded) return [];
     
     return [
       {
         id: "0",
         title: t('rights.slide1.title'),
         content: t('rights.slide1.content')
       },
       {
         id: "1",
         title: t('rights.slide2.title'),
         content: t('rights.slide2.content')
       },
       {
         id: "2",
         title: t('rights.slide3.title'),
         content: t('rights.slide3.content')
       },
       {
         id: "3",
         title: t('rights.slide4.title'),
         content: t('rights.slide4.content')
       },
       {
         id: "4",
         title: t('rights.slide5.title'),
         content: t('rights.slide5.content')
       },
       {
         id: "5",
         title: t('rights.slide6.title'),
         content: t('rights.slide6.content')
       }
     ];
   }, [t, translationsLoaded]);
 
   // Return loading state if translations aren't ready
   if (!translationsLoaded) {
     return (
       <PageLoading message={t('common.loading')} />
     );
   }

  return (
    <>
      <Container className="faqs-container mt-3 mb-3">
        <Row className="mt-2">
          <Col>
            <Card className="faqs-card">
              <Row className="g-0">
                <Col md={12} className="no-padding-inherit-faq">
                  <>
                    <h4 className="faqs-header mt-4 px-4">{t('rights.title')}</h4>
                    <Accordion defaultActiveKey={null} className="mb-3 faqs-accordion">
                      {rightsByLanguage.map((faq) => (
                        <Accordion.Item key={faq.id} eventKey={faq.id}>
                          <Accordion.Header>
                            {faq.title}
                          </Accordion.Header>
                          <Accordion.Body>
                            <div className="faq-content">
                              {faq.content}
                            </div>
                          </Accordion.Body>
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

export default ParentRights; 
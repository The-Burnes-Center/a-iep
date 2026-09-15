import React from 'react';
import { Container, Row, Col, Card } from 'react-bootstrap';
import PageLoading from '../components/PageLoading';
import { useLanguage } from '../common/language-context';
import Breadcrumbs from '../components/Breadcrumbs';
import './PrivacyPolicy.css';

interface PrivacyPolicyProps {
  /**
   * True on /public-privacy-policy, false on the signed-in /privacy-policy.
   * The two copies are the same page under different breadcrumbs: the public
   * one sits under the public About, the signed-in one under the in-app one.
   *
   * It used to pick the header as well (LandingTopNavigation vs
   * MobileTopNavigation). That is the layout route's answer now
   * (components/RouteChrome.tsx), which is also why the loading state below
   * no longer strips the header off the page.
   */
  isPublic?: boolean;
}

const PrivacyPolicy: React.FC<PrivacyPolicyProps> = ({ isPublic = false }) => {
  const { t, translationsLoaded } = useLanguage();

  // Return loading state if translations aren't ready
  if (!translationsLoaded) {
    return (
      <PageLoading message={t('common.loading')} />
    );
  }

  return (
    <div className="privacy-policy-page">
      {/* Breadcrumbs */}
      <Breadcrumbs
        trail={[
          {
            labelKey: "privacyPolicy.breadcrumb.about",
            // The public copy of this page sits under the public About, the
            // signed-in copy under the in-app one.
            to: isPublic ? "/about-the-project" : "/about-the-app",
          },
          { labelKey: "privacyPolicy.breadcrumb.privacyPolicy" },
        ]}
      />

      <Container className="privacy-policy-container">
        <Row className="mt-2">
          <Col>
            <Card className="privacy-policy-card">
              <Row  style={{ width: '100%', justifyContent: 'center' }}>
                <Col  xs={12} md={8} lg={6} className='pb-4'>
  
                  {/* Main Heading */}
                  <h4 className="privacy-policy-title">{t('privacyPolicy.title')}</h4>
        
                  {/* Effective Date */}
                  <p className="effective-date"><strong>{t('privacyPolicy.effectiveDate')}</strong></p>

                  {/* Introduction */}
                  <p className="privacy-intro">
                    {t('privacyPolicy.intro')}
                  </p>

                  {/* Section 1: How We Handle IEP Documents */}
                  <section className="privacy-section">
                    <h5 className="section-heading">
                      {t('privacyPolicy.iepDocuments.title')}
                    </h5>
          
                    <h6 className="subsection-heading">{t('privacyPolicy.iepDocuments.subtitle')}</h6>
          
                    <ul className="privacy-list">
                      <li>{t('privacyPolicy.iepDocuments.item1')}</li>
                      <li>{t('privacyPolicy.iepDocuments.item2')}</li>
                      <li>{t('privacyPolicy.iepDocuments.item3')}</li>
                      <li>{t('privacyPolicy.iepDocuments.item4')}</li>
                    </ul>
                  </section>

                  {/* Section 2: The Language Models We Use */}
                  <section className="privacy-section">
                    <h5 className="section-heading">{t('privacyPolicy.languageModels.title')}</h5>
          
                    <ul className="privacy-list">
                      <li>{t('privacyPolicy.languageModels.item1')}</li>
                      <li>{t('privacyPolicy.languageModels.item2')}</li>
                    </ul>
                  </section>

                  {/* Section 3: How We Keep Everything Secure */}
                  <section className="privacy-section">
                    <h5 className="section-heading">{t('privacyPolicy.security.title')}</h5>
          
                    <p className="section-intro">
                      {t('privacyPolicy.security.intro')}
                    </p>

                    <h6 className="subsection-heading">{t('privacyPolicy.security.access.title')}</h6>
                    <ul className="privacy-list">
                      <li>
                        <strong>{t('privacyPolicy.security.access.item1')}</strong> {t('privacyPolicy.security.access.item1.desc')}
                      </li>
                      <li>
                        <strong>{t('privacyPolicy.security.access.item2')}</strong> {t('privacyPolicy.security.access.item2.desc')}
                      </li>
                      <li>
                        <strong>{t('privacyPolicy.security.access.item3')}</strong> {t('privacyPolicy.security.access.item3.desc')}
                      </li>
                    </ul>

                    <h6 className="subsection-heading">{t('privacyPolicy.security.infrastructure.title')}</h6>
                    <ul className="privacy-list">
                      <li>
                        <strong>{t('privacyPolicy.security.infrastructure.item1')}</strong> {t('privacyPolicy.security.infrastructure.item1.desc')}
                      </li>
                      <li>
                        <strong>{t('privacyPolicy.security.infrastructure.item2')}</strong> {t('privacyPolicy.security.infrastructure.item2.desc')}
                      </li>
                      <li>
                        <strong>{t('privacyPolicy.security.infrastructure.item3')}</strong> {t('privacyPolicy.security.infrastructure.item3.desc')}
                      </li>
                    </ul>

                    <h6 className="subsection-heading">{t('privacyPolicy.security.monitoring.title')}</h6>
                    <ul className="privacy-list">
                      <li>
                        <strong>{t('privacyPolicy.security.monitoring.item1')}</strong> {t('privacyPolicy.security.monitoring.item1.desc')}
                      </li>
                      <li>
                        <strong>{t('privacyPolicy.security.monitoring.item2')}</strong> {t('privacyPolicy.security.monitoring.item2.desc')}
                      </li>
                    </ul>

                    <h6 className="subsection-heading">{t('privacyPolicy.security.problems.title')}</h6>
                    <ul className="privacy-list">
                      <li>
                        <strong>{t('privacyPolicy.security.problems.item1')}</strong> {t('privacyPolicy.security.problems.item1.desc')}
                      </li>
                      <li>
                        <strong>{t('privacyPolicy.security.problems.item2')}</strong> {t('privacyPolicy.security.problems.item2.desc')}
                      </li>
                    </ul>

                    <h6 className="subsection-heading">{t('privacyPolicy.security.sensitive.title')}</h6>
                    <ul className="privacy-list">
                      <li>
                        <strong>{t('privacyPolicy.security.sensitive.item1')}</strong> {t('privacyPolicy.security.sensitive.item1.desc')}
                      </li>
                    </ul>
                  </section>

                  {/* Section 4: How We Handle Phone Numbers */}
                  <section className="privacy-section">
                    <h5 className="section-heading">{t('privacyPolicy.phoneNumbers.title')}</h5>
          
                    <ul className="privacy-list">
                      <li>{t('privacyPolicy.phoneNumbers.item1')}</li>
                      <li>{t('privacyPolicy.phoneNumbers.item2')}</li>
                      <li>{t('privacyPolicy.phoneNumbers.item3')}</li>
                      <li>{t('privacyPolicy.phoneNumbers.item4')}</li>
                      <li>{t('privacyPolicy.phoneNumbers.item5')}</li>
                    </ul>
                  </section>

                  {/* Section 5: Your Rights and Choices */}
                  <section className="privacy-section">
                    <h5 className="section-heading">{t('privacyPolicy.rights.title')}</h5>
          
                    <ul className="privacy-list">
                      <li>{t('privacyPolicy.rights.item1')}</li>
                      <li>{t('privacyPolicy.rights.item2')}</li>
                    </ul>
                  </section>

                  {/* Section 6: Contact */}
                  <section className="privacy-section">
                    <h5 className="section-heading">{t('privacyPolicy.contact.title')}</h5>
          
                    <p className="contact-info">
                      {t('privacyPolicy.contact.intro')}
                    </p>
          
                    <p className="contact-details">
                      <strong>{t('privacyPolicy.contact.organization')}</strong><br />
                      {t('privacyPolicy.contact.email')} <a href="mailto:info@thegovlab.org">info@thegovlab.org</a>
                    </p>
                  </section>
                </Col>
              </Row>
            </Card>
          </Col>
        </Row>
      </Container>
    </div>
  );
};

export default PrivacyPolicy;
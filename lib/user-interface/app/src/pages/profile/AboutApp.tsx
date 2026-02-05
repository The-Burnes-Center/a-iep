import { useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Container, Row, Col, Breadcrumb, Spinner } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { useLanguage } from '../../common/language-context';
import GoToWebsiteButton from '../../components/GoToWebsiteButton';
import MobileTopNavigation from '../../components/MobileTopNavigation';
import AIEPFooter from '../../components/AIEPFooter';
import LandingHeroSection from '../../components/LandingHeroSection';
import GreenSection from '../../components/GreenSection';
import LandingContainer from '../../components/LandingContainer';
import LandingContainerBottom from '../../components/LandingContainerBottom';
import TransparentHeader from '../../components/TransparentHeader';
import './ProfileForms.css';
import './UpdateProfileName.css';
import './ProfileForms.css';
import './AboutApp.css';

const publicFooterLinks = [
  { route: '/', labelKey: 'footer.home' },
  { route: '/login', labelKey: 'footer.uploadIEP' },
  { route: '/faqs', labelKey: 'footer.faqs' },
  { route: '/about-the-project', labelKey: 'footer.aboutUs' },
];

interface AboutAppProps {
  NavigationComponent?: React.ComponentType;
  showBreadcrumbs?: boolean;
}

export default function AboutApp({ 
  NavigationComponent = MobileTopNavigation,
  showBreadcrumbs = true 
}: AboutAppProps = {}) {
  const navigate = useNavigate();
  const appContext = useContext(AppContext);
  const { t, translationsLoaded } = useLanguage();

  const apiClient = new ApiClient(appContext!);

  // TODO : Handle loading and error handling
  const { data } = useQuery({
    queryKey: ['teamMembers'],
    queryFn: async () => {
      const response = await apiClient.team.getTeamMembersInfo();
      return response?.team || [];
    },
  });

  const teamMembers = data || [];

  const parentNavigator = [
    {id: '1', first_name: 'Aracelli', last_name: 'Arellano', title: 'Innovate Parent Navigators - Bay Area', headshot: '/images/navigators/Aracelli_Arellano.png'},
    {id: '2', first_name: 'Roberto', last_name: 'Guzman', title: 'Innovate Parent Navigators - Bay Area', headshot: '/images/navigators/Roberto_Guzman.png'},
    {id: '3', first_name: 'Rosa', last_name: 'Mendoza', title: 'Innovate Parent Navigators - Bay Area', headshot: '/images/navigators/Rosa_Mendoza.png'},
    {id: '4', first_name: 'Shan', last_name: 'Hong', title: 'Innovate Parent Navigators - Bay Area', headshot: '/images/navigators/Shan_Hong.png'},
    {id: '5', first_name: 'Martha', last_name: 'Mejia', title: 'Innovate Parent Navigators - Bay Area', headshot: '/images/navigators/Martha_Mejia.png'},
    {id: '6', first_name: 'Noelia', last_name: 'Solval', title: 'Innovate Parent Navigators - Bay Area', headshot: '/images/navigators/Noelia_Solval.png'},
    {id: '7', first_name: 'Carmen', last_name: 'Rodriguez', title: 'Innovate Parent Navigators - Bay Area', headshot: '/images/navigators/Carmen_Rodriguez.png'}];

  const handleBackClick = () => {
    navigate('/support-center');
  };

  // Return loading state if translations aren't ready
  if (!translationsLoaded) {
    return (
      <Container className="mt-4 mb-5">
        <div className="text-center my-5">
          <Spinner animation="border" role="status">
            <span className="visually-hidden">Loading...</span>
          </Spinner>
        </div>
      </Container>
    );
  }

  return (
    <>
      <NavigationComponent />
      <div>
      {/* Breadcrumbs - only show when enabled */}
      {showBreadcrumbs && (
        <div className="mt-3 text-start px-4 breadcrumb-container">
          <Breadcrumb>
            <Breadcrumb.Item onClick={handleBackClick}>{t("about.breadcrumb.supportCenter")}</Breadcrumb.Item>
            <Breadcrumb.Item active>{t("about.breadcrumb.about")}</Breadcrumb.Item>
          </Breadcrumb>
        </div>
      )}
      
      <LandingHeroSection />
      <GreenSection />
      <LandingContainer />

      <div className='about-app-all-content-container'>

      <TransparentHeader title={t("about.parentNavigatorsTitle")} />

      <div className='parent-navigators-list-container-top-row'>
            {parentNavigator.slice(0, 4).map((member) => (
              <div key={member.id} className='parent-navigator-item'>
                <div className='parent-navigator-item-image'>
                  <img 
                    src={member.headshot}
                    alt={`${member.first_name} ${member.last_name}`}
                  />
                </div>
                <div className='parent-navigator-item-content'>
                  <h5>{member.first_name} {member.last_name}</h5>
                  <p>{member.title}</p>
                </div>
              </div>
            ))}
          </div>
          <div className='parent-navigators-list-container-bottom-row'>
            {parentNavigator.slice(4).map((member) => (
              <div key={member.id} className='parent-navigator-item'>
                <div className='parent-navigator-item-image'>
                  <img 
                    src={member.headshot}
                    alt={`${member.first_name} ${member.last_name}`}
                  />
                </div>
                <div className='parent-navigator-item-content'>
                  <h5>{member.first_name} {member.last_name}</h5>
                  <p>{member.title}</p>
                </div>
              </div>
            ))}
          </div>

          <LandingContainerBottom />

          <TransparentHeader title={t("about.theTeam")} />

          <div className='team-members-list-container'>
            {teamMembers.map((member) => (
              <div key={member.id} className='team-member-item'>
                <div className='team-member-item-image'>
                  <img 
                    src={`https://directus.theburnescenter.org/assets/${member.thumbnail?.filename_disk}`}
                    alt={`${member.first_name} ${member.last_name}`}
                  />
                </div>
                <div className='team-member-item-content'>
                  <h5>{member.first_name} {member.last_name}</h5>
                  <p>{member.title}</p>
                </div>
              </div>
            ))}
          </div>

        <div className="about-app-partner-container">
          <div className='about-app-partner-container-text'>
            <h4 className='about-app-header'>{t("about.aboutTheGovLab")}</h4>
            <p className='about-text'>{t("about.theGovLabDescription")}</p>
            <GoToWebsiteButton url={"https://thegovlab.org/"} buttonText={t("about.learnMore")} />
          </div>
          <div className='gov-lab-logo-container'>
              <img src="/images/the_govlab_logo 1.png" alt="The Gov Lab Logo" />
          </div>
        </div>

        <div className="about-app-partner-container">
          <div className='about-app-partner-container-text'>
            <h4 className='about-app-header'>{t("about.aboutInnovatePublicSchools")}</h4>
            <p className='about-text'>{t("about.innovatePublicSchoolsDescription")}</p>
            <GoToWebsiteButton url={"https://innovateschools.org/"} buttonText={t("about.learnMore")} />
          </div>
          <div className='innovate-schools-logo-container'>
              <img src="/images/innovate_logo.png" alt="Innovate Public Schools Logo" />
          </div>
        </div>

        <div className='privacy-policy-header section-header--privacy' style={{ cursor: 'pointer' }} onClick={() => navigate(showBreadcrumbs ? '/privacy-policy' : '/public-privacy-policy')}>
          <h5>{t("about.privacyPolicy")}</h5>
          <span className="arrow-icon">
            <img src="/images/arrow.svg" alt="" />
          </span>
        </div>

        <div className='bottom-space-about-app'>
        </div>
      </div>
      
      </div>
      <AIEPFooter {...(!showBreadcrumbs && { footerLinks: publicFooterLinks })} />
    </>
  );
};
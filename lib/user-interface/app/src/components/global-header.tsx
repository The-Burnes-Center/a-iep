import React, { useEffect, useState, useContext } from "react";
import { Navbar, Container, Nav, Button, Dropdown } from 'react-bootstrap';
import { Auth } from "aws-amplify";
import { useAuth } from "../common/auth-provider";
import { AppContext } from "../common/app-context";
import { ApiClient } from "../common/api-client/api-client";
import { CHATBOT_NAME } from "../common/constants";
import { Link } from 'react-router-dom';
import { useNavigate } from 'react-router-dom';
import { useLanguage, SupportedLanguage } from '../common/language-context';
import { useNotifications } from './notif-manager';
import 'bootstrap/dist/css/bootstrap.min.css';
import './global-header.css';

export default function GlobalHeader() {
  const [userName, setUserName] = useState<string | null>(null);
  const { setAuthenticated } = useAuth();
  const appContext = useContext(AppContext);
  const { language, setLanguage } = useLanguage();
  const { addNotification } = useNotifications();
  const navigate = useNavigate();
  const [showMenu, setShowMenu] = useState(false);

  // This useEffect hook runs once when the component mounts and checks if the user is authenticated
  useEffect(() => {
    const fetchUserInfo = async () => {
      // Checks if there's a valid session with AWS Cognito
      const result = await Auth.currentAuthenticatedUser();
      
      // Sign out if there is no valid session
      if (!result || Object.keys(result).length === 0) {
        // console.log("Signed out!")
        Auth.signOut();
        setAuthenticated(false);
        return;
      }

      // Gets user details from Cognito tokens
      const name = result?.signInUserSession?.idToken?.payload?.name;
      const email = result?.signInUserSession?.idToken?.payload?.email
      const userName = name? name : email;
      setUserName(userName);
    };

    fetchUserInfo();

    // Add click event listener to close menu when clicking outside
    const handleClickOutside = (event) => {
      if (showMenu && !event.target.closest('.menu-container')) {
        setShowMenu(false);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [showMenu]);

  // When user signs out Auth.signOut() clears out all the tokens
  const handleSignOut = async () => {
    try {
      navigate('/login', { replace: true });
      await Auth.signOut();
      setAuthenticated(false);
    } catch (error) {
      // console.error("Error signing out:", error);
    }
  };

  const toggleMenu = (e) => {
    e.stopPropagation();
    setShowMenu(!showMenu);
  };

  // Handle language change
  const handleLanguageChange = async (lang: SupportedLanguage) => {
    // Update UI language immediately for responsive UX
    setLanguage(lang);
    
    // Update backend profile to sync language preference
    try {
      const apiClient = new ApiClient(appContext);
      
      // Get current profile
      const currentProfile = await apiClient.profile.getProfile();
      
      if (currentProfile) {
        // Update the secondary language (keeping primary as English)
        const updatedProfile = {
          ...currentProfile,
          primaryLanguage: 'en',
          secondaryLanguage: lang === 'en' ? undefined : lang
        };
        
        // Only update if there's actually a change
        if (currentProfile.secondaryLanguage !== updatedProfile.secondaryLanguage) {
          await apiClient.profile.updateProfile(updatedProfile);
          // console.log(`Language preference updated to: ${lang}`);
          
          // Show success notification
          const languageLabels = {
            'en': 'English',
            'es': 'Spanish',
            'zh': 'Chinese', 
            'vi': 'Vietnamese'
          };
          addNotification('success', `Language preference updated to ${languageLabels[lang] || lang}`);
        }
      }
    } catch (error) {
      // console.error('Failed to update language preference in profile:', error);
      // Don't show error to user as UI language change still works
      // The mismatch will be resolved when they manually update profile or re-upload
    }
  };

  // Language options with labels
  const languageOptions = [
    { value: 'en', label: 'English' },
    { value: 'es', label: 'Español' },
    { value: 'zh', label: '中文' },
    { value: 'vi', label: 'Tiếng Việt' },
    { value: 'ar', label: 'العربية' }
  ];

  return (
    <Navbar 
      variant="dark" 
      expand="lg" 
      fixed="top"
      className="custom-navbar"
    >
      <Container fluid>
        <Navbar.Brand as={Link} to="/welcome-page" className="d-flex align-items-center">
          <span className="aiep-navbar">AIEP</span>
        </Navbar.Brand>
        
        {/* Mobile hamburger button */}
        <Navbar.Toggle aria-controls="basic-navbar-nav" />
        
        <Navbar.Collapse id="basic-navbar-nav" className="justify-content-end">
          <Nav className="me-3">
            {/* Language Dropdown */}
            <Dropdown>
              <Dropdown.Toggle variant="outline-light" id="language-dropdown" size="sm">
                {languageOptions.find(option => option.value === language)?.label || 'English'}
              </Dropdown.Toggle>
              <Dropdown.Menu>
                {languageOptions.map(option => (
                  <Dropdown.Item 
                    key={option.value} 
                    onClick={() => handleLanguageChange(option.value as SupportedLanguage)}
                    active={language === option.value}
                  >
                    {option.label}
                  </Dropdown.Item>
                ))}
              </Dropdown.Menu>
            </Dropdown>
          </Nav>
          
          <Nav>
            {/* For mobile view - appears when navbar is expanded */}
            <Nav.Link 
              className="d-lg-none" 
              onClick={handleSignOut}
            >
              Sign out
            </Nav.Link>
            
            {/* For desktop view - custom hamburger menu */}
            <div className="d-none d-lg-block menu-container">
              <Button 
                variant="link" 
                className="hamburger-button" 
                onClick={toggleMenu}
              >
                <i className="bi bi-list"></i>
              </Button>
              
              {showMenu && (
                <div className="custom-dropdown-menu">
                  <div 
                    className="custom-dropdown-item" 
                    onClick={handleSignOut}
                  >
                    Sign out
                  </div>
                </div>
              )}
            </div>
          </Nav>
        </Navbar.Collapse>
      </Container>
    </Navbar>
  );
}
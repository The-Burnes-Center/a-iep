import React, { useContext } from 'react';
import { Container, Form, Row, Col, Alert, Spinner, Breadcrumb } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AppContext } from '../../common/app-context';
import MobileTopNavigation from '../../components/MobileTopNavigation';
import AIEPFooter from '../../components/AIEPFooter';
import { ApiClient } from '../../common/api-client/api-client';
import { UserProfile } from '../../common/types';
import { useLanguage, SupportedLanguage } from '../../common/language-context'; 
import './ChangeLanguage.css';
import './ProfileForms.css';

export default function ChangeLanguage() {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t, setLanguage } = useLanguage();

  // Language options - hardcoded so users can always read the language names
  const LANGUAGE_OPTIONS = [
    { value: 'en', label: 'English' },
    { value: 'zh', label: '中文' },
    { value: 'es', label: 'Español' },
    { value: 'vi', label: 'Tiếng Việt' }
  ];

  // ============================================================================
  // DATA FETCHING WITH REACT QUERY
  // ============================================================================
  // useQuery automatically handles:
  // - Loading state (isLoading) - no need for manual setLoading(true/false)
  // - Error state (error) - no need for manual try/catch and setError
  // - Caching - if user navigates away and back, data is served from cache
  // - Background refetching - keeps data fresh automatically
  //
  // The 'queryKey' is a unique identifier for this cached data. Any component
  // using the same queryKey will share the same cached data.
  const { data: originalProfile, isLoading, error } = useQuery({
    queryKey: ['profile'],
    queryFn: () => apiClient.profile.getProfile(),
  });

  // ============================================================================
  // MUTATION FOR UPDATING PROFILE
  // ============================================================================
  // Execution order when mutate(data) is called:
  // 1. onMutate  — runs BEFORE the API call (optimistic cache update + snapshot for rollback)
  // 2. mutationFn — the actual API call
  // 3. onSuccess  — if API succeeded (update language context, invalidate cache)
  //    OR onError — if API failed (roll back cache to snapshot)
  const updateProfileMutation = useMutation({
    mutationFn: (updatedProfile: UserProfile) => apiClient.profile.updateProfile(updatedProfile),
    onMutate: async (updatedProfile) => {
      // Cancel any in-flight refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: ['profile'] });

      // Snapshot the current cache value for rollback
      const previousProfile = queryClient.getQueryData<UserProfile>(['profile']);

      // Optimistically update the cache — UI reflects the change immediately
      queryClient.setQueryData(['profile'], updatedProfile);

      return { previousProfile };
    },
    onSuccess: (_, updatedProfile) => {
      // Update the app's language context so UI translations change
      if (updatedProfile.secondaryLanguage) {
        setLanguage(updatedProfile.secondaryLanguage as SupportedLanguage);
      }
      // Invalidate the 'profile' query cache to refetch the confirmed server state
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
    onError: (_error, _updatedProfile, context) => {
      // Roll back the cache to the previous value
      if (context?.previousProfile) {
        queryClient.setQueryData(['profile'], context.previousProfile);
      }
    },
  });

  const handleBackClick = () => {
    navigate('/account-center');
  };

  // ============================================================================
  // LANGUAGE CHANGE HANDLER
  // ============================================================================
  // The mutation's onMutate handles the optimistic cache update, so we just
  // need to trigger the mutation here. On success, the cache is invalidated.
  // On failure, onError rolls back the cache automatically.
  const handlePreferredLanguageChange = (languageCode: string) => {
    if (!originalProfile || languageCode === originalProfile.secondaryLanguage) return;

    const updatedProfile = { ...originalProfile, secondaryLanguage: languageCode };
    updateProfileMutation.mutate(updatedProfile);
  };

  if (isLoading) {
    return (
      <Container className="text-center">
        <Spinner animation="border" role="status">
          <span className="visually-hidden">{t('changeLanguage.loading')}</span>
        </Spinner>
      </Container>
    );
  }

  if (error) {
    return (
      <Container>
        <Alert variant="danger">{t('profile.error.serviceUnavailable')}</Alert>
      </Container>
    );
  }

  return (
  <>
      <MobileTopNavigation />
      <div>
      {/* Breadcrumbs */}
      <div className="mt-3 text-start px-4 breadcrumb-container">
        <Breadcrumb>
          <Breadcrumb.Item onClick={handleBackClick}>{t('changeLanguage.breadcrumb.account')}</Breadcrumb.Item>
          <Breadcrumb.Item active>{t('changeLanguage.breadcrumb.changeLanguage')}</Breadcrumb.Item>
        </Breadcrumb>
      </div>
      
      <Container 
        fluid 
        className="update-profile-container"
      >
        <Row style={{ width: '100%', justifyContent: 'center' }}>
          <Col xs={12} md={8} lg={6}>
            <div className="profile-form">
            {/*Add translations*/}
            <h4 className="update-profile-header">{t('changeLanguage.title')}</h4>
            <p className='update-profile-description'>{t('changeLanguage.description')}</p>
              <Form>
                <Row className="mb-4">
                  <Col md={12}>
                    <Form.Group controlId="formParentName">
                      <Form.Label className="form-label">{t('changeLanguage.label.translation')}</Form.Label>
                    </Form.Group>
                  </Col>
                </Row>

                {/* Preferred Language Section */}
                <Row className="mb-4">
                  <Col md={10}>
                    <Form.Group controlId="formPreferredLanguage">
                      {/* 
                        isPending is true while the mutation is in progress.
                        We disable the select to prevent multiple rapid changes
                        while a save is in flight.
                      */}
                      <Form.Select 
                        value={originalProfile?.secondaryLanguage || 'en'}
                        onChange={e => handlePreferredLanguageChange(e.target.value)}
                        disabled={updateProfileMutation.isPending}
                        className='language-select-dropdown'
                      >
                        {LANGUAGE_OPTIONS.map(option => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Form.Select>
                    </Form.Group>
                  </Col>
                </Row>
              </Form>
            </div>
          </Col>
        </Row>
      </Container>
    </div>
    <AIEPFooter />
  </>
  );
}
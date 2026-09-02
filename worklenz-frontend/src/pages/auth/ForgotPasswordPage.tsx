import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMediaQuery } from 'react-responsive';
import { useNavigate } from 'react-router-dom';
import { UserOutlined } from '@/shared/antd-imports';
import { Form, Card, Input, Flex, Button, Typography, Result } from '@/shared/antd-imports';

import PageHeader from '@components/AuthPageHeader';

import { useDocumentTitle } from '@/hooks/useDoumentTItle';
import { useMixpanelTracking } from '@/hooks/useMixpanelTracking';
import {
  evt_forgot_password_page_visit,
  evt_reset_password_click,
  evt_login_with_google_click,
  evt_login_with_keycloak_click,
} from '@/shared/worklenz-analytics-events';
import { resetPassword, verifyAuthentication } from '@features/auth/authSlice';
import { useAppDispatch } from '@/hooks/useAppDispatch';
import { setSession } from '@/utils/session-helper';
import { setUser } from '@features/user/userSlice';
import logger from '@/utils/errorLogger';

// Add Apple login event (following existing pattern in LoginPage/SignupPage)
const evt_login_with_apple_click = 'login_with_apple_click';

const ForgotPasswordPage = () => {
  const [form] = Form.useForm();
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [isOAuthUser, setIsOAuthUser] = useState(false);
  const [urlParams, setUrlParams] = useState({
    teamId: '',
  });

  const navigate = useNavigate();
  const { trackMixpanelEvent } = useMixpanelTracking();
  useDocumentTitle('Forgot Password');
  const dispatch = useAppDispatch();

  // Localization
  const { t } = useTranslation('auth/forgot-password');

  // media queries from react-responsive package
  const isMobile = useMediaQuery({ query: '(max-width: 576px)' });

  useEffect(() => {
    trackMixpanelEvent(evt_forgot_password_page_visit);
    const searchParams = new URLSearchParams(window.location.search);
    setUrlParams({
      teamId: searchParams.get('team') || '',
    });
    const verifyAuthStatus = async () => {
      try {
        const session = await dispatch(verifyAuthentication()).unwrap();
        if (session?.authenticated) {
          setSession(session.user);
          dispatch(setUser(session.user));
          navigate('/worklenz/home');
        }
      } catch (error) {
        logger.error('Failed to verify authentication status', error);
      }
    };
    void verifyAuthStatus();
  }, [dispatch, navigate, trackMixpanelEvent]);

  const onFinish = useCallback(
    async (values: any) => {
      if (values.email.trim() === '') return;
      try {
        setIsLoading(true);
        setIsOAuthUser(false); // Reset OAuth user state
        // Normalize email to lowercase for case-insensitive comparison
        const normalizedEmail = values.email.toLowerCase().trim();
        const result = await dispatch(resetPassword(normalizedEmail)).unwrap();
        if (result.done) {
          trackMixpanelEvent(evt_reset_password_click);
          setIsSuccess(true);
        } else if (result.body === 'oauth_user') {
          setIsOAuthUser(true);
        }
      } catch (error: any) {
        logger.error('Failed to reset password', error);
        // Check if the error response indicates an OAuth user
        if (error?.response?.data?.body === 'oauth_user') {
          setIsOAuthUser(true);
        }
      } finally {
        setIsLoading(false);
      }
    },
    [dispatch, trackMixpanelEvent]
  );

  const enableGoogleLogin = import.meta.env.VITE_ENABLE_GOOGLE_LOGIN === 'true' || false;
  const enableAppleLogin = import.meta.env.VITE_ENABLE_APPLE_LOGIN === 'true' || false;
  const enableKeycloakLogin = import.meta.env.VITE_ENABLE_KEYCLOAK_LOGIN === 'true' || false;

  const handleGoogleSignIn = useCallback(() => {
    trackMixpanelEvent(evt_login_with_google_click);
    const url = `${import.meta.env.VITE_API_URL}/secure/google`;
    window.location.href = url;
  }, [trackMixpanelEvent]);

  const handleAppleSignIn = useCallback(() => {
    trackMixpanelEvent(evt_login_with_apple_click);
    const url = `${import.meta.env.VITE_API_URL}/secure/apple`;
    window.location.href = url;
  }, [trackMixpanelEvent]);

  const handleKeycloakSignIn = useCallback(() => {
    trackMixpanelEvent(evt_login_with_keycloak_click);
    const url = `${import.meta.env.VITE_API_URL}/secure/keycloak`;
    window.location.href = url;
  }, [trackMixpanelEvent]);

  const handleTryDifferentEmail = useCallback(() => {
    setIsOAuthUser(false);
    form.resetFields();
  }, [form]);

  return (
    <Card
      style={{
        width: '100%',
        boxShadow: 'none',
      }}
      styles={{
        body: {
          paddingInline: isMobile ? 24 : 48,
        },
      }}
      variant="outlined"
    >
      {isSuccess ? (
        <Result status="success" title={t('successTitle')} subTitle={t('successMessage')} />
      ) : isOAuthUser ? (
        <Result
          status="info"
          title={t('oauthUserTitle')}
          subTitle={t('oauthUserMessage')}
          extra={[
            enableGoogleLogin && (
              <Button
                key="google-signin"
                type="primary"
                size="large"
                onClick={handleGoogleSignIn}
                style={{ borderRadius: 4 }}
              >
                {t('signInWithGoogleButton', { defaultValue: 'Sign in with Google' })}
              </Button>
            ),
            enableAppleLogin && (
              <Button
                key="apple-signin"
                type="primary"
                size="large"
                onClick={handleAppleSignIn}
                style={{ borderRadius: 4 }}
              >
                {t('signInWithAppleButton', { defaultValue: 'Sign in with Apple' })}
              </Button>
            ),
            enableKeycloakLogin && (
              <Button
                key="keycloak-signin"
                type="primary"
                size="large"
                onClick={handleKeycloakSignIn}
                style={{ borderRadius: 4 }}
              >
                {t('signInWithKeycloakButton', { defaultValue: 'Sign in with Keycloak' })}
              </Button>
            ),
            <Button
              key="try-different"
              type="default"
              size="large"
              onClick={handleTryDifferentEmail}
              style={{ borderRadius: 4 }}
            >
              {t('tryDifferentEmailButton')}
            </Button>,
          ].filter(Boolean)}
        />
      ) : (
        <>
          <PageHeader description={t('headerDescription')} />
          <Form
            name="forgot-password"
            form={form}
            layout="vertical"
            autoComplete="off"
            requiredMark="optional"
            initialValues={{ remember: true }}
            onFinish={onFinish}
            style={{ width: '100%' }}
          >
            <Form.Item
              name="email"
              rules={[
                {
                  required: true,
                  type: 'email',
                  message: t('emailRequired'),
                },
              ]}
            >
              <Input
                prefix={<UserOutlined />}
                placeholder={t('emailPlaceholder', { defaultValue: 'Enter your email' })}
                size="large"
                style={{ borderRadius: 4 }}
              />
            </Form.Item>

            <Form.Item>
              <Flex vertical gap={8}>
                <Button
                  block
                  type="primary"
                  htmlType="submit"
                  size="large"
                  loading={isLoading}
                  style={{ borderRadius: 4 }}
                >
                  {t('resetPasswordButton', { defaultValue: 'Reset Password' })}
                </Button>
                <Typography.Text style={{ textAlign: 'center' }}>{t('orText')}</Typography.Text>
                <Button
                  block
                  type="default"
                  size="large"
                  onClick={() => navigate('/auth/login')}
                  style={{
                    borderRadius: 4,
                  }}
                >
                  {t('returnToLoginButton', { defaultValue: 'Return to Login' })}
                </Button>
              </Flex>
            </Form.Item>
          </Form>
        </>
      )}
    </Card>
  );
};

export default ForgotPasswordPage;

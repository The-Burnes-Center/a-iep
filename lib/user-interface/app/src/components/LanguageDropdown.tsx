import React from 'react';
import { SupportedLanguage, useLanguage } from '../common/language-context';
import LanguageMenu from './LanguageMenu';
import './LanguageDropdown.css';

interface LanguageOption {
  value: string;
  label: string;
}

interface LanguageDropdownProps {
  language: string;
  languageOptions: LanguageOption[];
  onLanguageChange: (lang: SupportedLanguage) => void;
  variant?: 'default' | 'secondary';
}

/**
 * The public site's language picker (header, landing hero and sign-in). It
 * sets the screen's language only; signed in, the top bar's picker saves the
 * parent's preference instead. The menu itself is LanguageMenu, shared with
 * the in-app pickers so all of them are announced and operated the same way.
 */
const LanguageDropdown: React.FC<LanguageDropdownProps> = ({
  language,
  languageOptions,
  onLanguageChange,
  variant = 'default'
}) => {
  const { t } = useLanguage();
  return (
    <div className={`language-login-dropdown${variant === 'secondary' ? ' language-dropdown--secondary' : ''}`}>
      <LanguageMenu
        options={languageOptions}
        selected={language}
        onSelect={(value) => onLanguageChange(value as SupportedLanguage)}
        name={t('languageMenu.label')}
        toggleVariant="outline-secondary"
        align="start"
      />
    </div>
  );
};

export default LanguageDropdown;

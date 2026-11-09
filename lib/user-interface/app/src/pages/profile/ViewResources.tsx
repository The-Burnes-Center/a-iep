import PageLoading from '../../components/PageLoading';
import PageShell from '../../components/page/PageShell';
import PageHero from '../../components/page/PageHero';
import { useLanguage } from '../../common/language-context';
import './ChangeLanguage.css';
import './ProfileForms.css';
import './ViewResources.css';

export default function ViewResources() {
  const { t, translationsLoaded } = useLanguage();
  
  // Return loading state if translations aren't ready
  if (!translationsLoaded) {
    return (
      <PageLoading message={t('common.loading')} />
    );
  }

  const resources = [
    {
      title: t("resources.toolkit.title"),
      description: t("resources.toolkit.description"),
      url: "https://www.disabilityrightsca.org/resources/special-education/special-education-basics-toolkit",
      buttonText: t("resources.buttonText")
    },
    {
      title: t("resources.walletCard.title"), 
      description: t("resources.walletCard.description"),
      url: "https://www.disabilityrightsca.org/publications/know-your-rights-wallet-card",
      buttonText: t("resources.buttonText")
    },
    {
      title: t("resources.advocacyTips.title"),
      description: t("resources.advocacyTips.description"),
      url: "https://www.disabilityrightsca.org/publications/17-special-education-advocacy-tips",
      buttonText: t("resources.buttonText")
    },
    {
      title: t("resources.rulaManual.title"),
      description: t("resources.rulaManual.description"),
      url: "https://rula.disabilityrightsca.org/",
      buttonText: t("resources.buttonText")
    }
  ];

  return (
    <PageShell trail={[
      { labelKey: "resources.breadcrumb.supportCenter", to: "/support-center" },
      { labelKey: "resources.breadcrumb.resources" },
    ]}>
      <PageHero titleId="resources-title" title={t("resources.title")} description={t("resources.description")} showFaces={false} />

      <ul className="resource-list">
        {resources.map((resource, index) => (
          <li key={index} className="page-card resource-item">
            <h2 className="page-card-title">{resource.title}</h2>
            <p className="page-card-text">{resource.description}</p>
            {/* Every link says which resource it opens: four identical
                "VIEW RESOURCES" names is what a screen reader user hears. */}
            <a
              className="ui-button ui-button--secondary resource-link"
              href={resource.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {resource.buttonText}
              <span className="visually-hidden">: {resource.title}</span>
            </a>
          </li>
        ))}
      </ul>
    </PageShell>
  );
}

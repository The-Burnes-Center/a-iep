import './GreenSection.css';
import Divider from './Divider';
import { useLanguage } from '../common/language-context';

const GreenSection = () => {
    const { t } = useLanguage();

    return (
        <div className="green-section">
            <Divider />
            <div className="green-content">
                <p className="green-content-title">{t('greenSection.title')}</p>
                <div className="green-content-row">
                    <p className="green-content-text">{t('greenSection.description1')}</p>
                    <p className="green-content-text">{t('greenSection.description2')}</p>
                </div>
            </div>
        </div>
    );
};

export default GreenSection;

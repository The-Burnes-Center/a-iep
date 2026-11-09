import Button from './ui/Button';
import './GoToWebsiteButton.css';

interface GoToWebsiteButtonProps {
  url: string;
  buttonText: string;
}

const GoToWebsiteButton = ({ url, buttonText }: GoToWebsiteButtonProps) => {
  return (
    <Button variant="secondary" className="go-to-website-button" href={url}>
      {buttonText}
    </Button>
  );
};

export default GoToWebsiteButton;
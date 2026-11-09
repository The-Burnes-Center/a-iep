import Button from './ui/Button';
import './ViewResourcesButton.css';

interface ViewResourcesButtonProps {
  url: string;
  buttonText: string;
}

const ViewResourcesButton = ({ url, buttonText }: ViewResourcesButtonProps) => {
  return (
    <Button variant="secondary" className="view-resources-button" href={url}>
      {buttonText}
    </Button>
  );
};

export default ViewResourcesButton;
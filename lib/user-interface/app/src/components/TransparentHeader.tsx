import './TransparentHeader.css';

interface TransparentHeaderProps {
  title: string;
}

const TransparentHeader = ({ title }: TransparentHeaderProps) => {
  return (
    <div className="transparent-section-header">
      <h5>{title}</h5>
    </div>
  );
};

export default TransparentHeader;

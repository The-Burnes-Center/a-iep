import React from "react";
import "./AIEPToolCard.css";

interface AIEPToolCardProps {
  topText: string;
  middleText: string;
  bottomText: string;
  backgroundImage?: string;
  onClick?: () => void;
}

const AIEPToolCard: React.FC<AIEPToolCardProps> = ({
  topText,
  middleText,
  bottomText,
  backgroundImage,
  onClick,
}) => {
  const cardStyle: React.CSSProperties = backgroundImage
    ? {
        backgroundImage: `url(${backgroundImage})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }
    : {};

  return (
    <div className="aiep-tool-card" style={cardStyle} onClick={onClick}>
      <div className="aiep-tool-card-content">
        <p className="aiep-tool-card-text">{topText}</p>
        <h5 className="aiep-tool-card-header">{middleText}</h5>
        <p className="aiep-tool-card-text">{bottomText}</p>
      </div>
      <div className="aiep-tool-card-icon">
        <img src="/images/go-to.svg" alt="Go to" />
      </div>
    </div>
  );
};

export default AIEPToolCard;

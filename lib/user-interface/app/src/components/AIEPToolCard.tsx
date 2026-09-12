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
  // The card's copy is cream, and the brand pattern photographs behind it run
  // from 1.39:1 (yellow) to 3.10:1 (red) against it -- the 18px body line was
  // unreadable on four of the six. The scrim is a flat --aiep-image-scrim
  // layer over the photograph, which puts the worst of them at 5.31:1. It has
  // to be set here rather than in AIEPToolCard.css because the url() is an
  // inline style and an inline background-image wins over the stylesheet.
  const cardStyle: React.CSSProperties = backgroundImage
    ? {
        backgroundImage: `linear-gradient(var(--aiep-image-scrim), var(--aiep-image-scrim)), url(${backgroundImage})`,
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

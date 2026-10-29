import React from "react";
import { Link } from "react-router-dom";
import "./AIEPToolCard.css";

interface AIEPToolCardProps {
  topText: string;
  middleText: string;
  bottomText: string;
  backgroundImage?: string;
  /** An app path ("/#sign-in") or an https:// URL. The whole card is the link. */
  href: string;
}

const isExternal = (href: string) => href.startsWith("https://");

const AIEPToolCard: React.FC<AIEPToolCardProps> = ({
  topText,
  middleText,
  bottomText,
  backgroundImage,
  href,
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

  const content = (
    <>
      <div className="aiep-tool-card-content">
        <p className="aiep-tool-card-text">{topText}</p>
        <h5 className="aiep-tool-card-header">{middleText}</h5>
        <p className="aiep-tool-card-text">{bottomText}</p>
      </div>
      <div className="aiep-tool-card-icon">
        <img loading="lazy" decoding="async" src="/images/go-to.svg" alt="" />
      </div>
    </>
  );

  // A real link, not a <div onClick>: it is in the tab order, answers Enter,
  // and the destination is in the markup for a crawler. Off-site links open a
  // new tab, as the hero's partner links do.
  if (isExternal(href)) {
    return (
      <a
        className="aiep-tool-card"
        style={cardStyle}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {content}
      </a>
    );
  }

  return (
    <Link className="aiep-tool-card" style={cardStyle} to={href}>
      {content}
    </Link>
  );
};

export default AIEPToolCard;

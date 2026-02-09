import React from "react";
import { useNavigate } from "react-router-dom";
import AIEPToolCard from "./AIEPToolCard";
import { useLanguage } from "../common/language-context";
import "./LandingCardSection.css";

const LandingCardSection: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useLanguage();

  return (
    <div className="landing-card-section">
      <div className="landing-card-grid">
        <AIEPToolCard
          topText={t("landingCards.aiepTool.top")}
          middleText={t("landingCards.aiepTool.middle")}
          bottomText={t("landingCards.aiepTool.bottom")}
          backgroundImage="/images/patterns-red-h.jpg"
          onClick={() => navigate("/login")}
        />
        <AIEPToolCard
          topText={t("landingCards.canvassing.top")}
          middleText={t("landingCards.canvassing.middle")}
          bottomText={t("landingCards.canvassing.bottom")}
          backgroundImage="/images/patterns-yellow-h.jpg"
          onClick={() => {}}
        />
        <AIEPToolCard
          topText={t("landingCards.blog.top")}
          middleText={t("landingCards.blog.middle")}
          bottomText={t("landingCards.blog.bottom")}
          backgroundImage="/images/patterns-orange-h.jpg"
          onClick={() => {}}
        />
        <AIEPToolCard
          topText={t("landingCards.course.top")}
          middleText={t("landingCards.course.middle")}
          bottomText={t("landingCards.course.bottom")}
          backgroundImage="/images/patterns-pink-h.jpg"
          onClick={() => {}}
        />
        <AIEPToolCard
          topText={t("landingCards.research.top")}
          middleText={t("landingCards.research.middle")}
          bottomText={t("landingCards.research.bottom")}
          backgroundImage="/images/patterns-blue-h.jpg"
          onClick={() => {}}
        />
        <AIEPToolCard
          topText={t("landingCards.playbook.top")}
          middleText={t("landingCards.playbook.middle")}
          bottomText={t("landingCards.playbook.bottom")}
          backgroundImage="/images/patterns-light-green-h.jpg"
          onClick={() => {}}
        />
      </div>
    </div>
  );
};

export default LandingCardSection;

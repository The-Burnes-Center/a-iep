import React from "react";
import AIEPToolCard from "./AIEPToolCard";
import { useLanguage } from "../common/language-context";
import { SIGN_IN_ROUTE } from "../common/sign-in-location";
import "./LandingCardSection.css";

/** Where the Reboot blog and the Civic AI course live. Off-site, so the cards open them in a new tab. */
const REBOOT_BLOG_URL = "https://rebootdemocracy.ai";
const CIVIC_AI_COURSE_URL = "https://bit.ly/civic-ai-course";

const LandingCardSection: React.FC = () => {
  const { t } = useLanguage();

  return (
    <div className="landing-card-section">
      <div className="landing-card-grid">
        <AIEPToolCard
          topText={t("landingCards.aiepTool.top")}
          middleText={t("landingCards.aiepTool.middle")}
          bottomText={t("landingCards.aiepTool.bottom")}
          backgroundImage="/images/patterns-red-h.jpg"
          href={SIGN_IN_ROUTE}
        />
        <AIEPToolCard
          topText={t("landingCards.blog.top")}
          middleText={t("landingCards.blog.middle")}
          bottomText={t("landingCards.blog.bottom")}
          backgroundImage="/images/patterns-orange-h.jpg"
          href={REBOOT_BLOG_URL}
        />
        <AIEPToolCard
          topText={t("landingCards.course.top")}
          middleText={t("landingCards.course.middle")}
          bottomText={t("landingCards.course.bottom")}
          backgroundImage="/images/patterns-pink-h.jpg"
          href={CIVIC_AI_COURSE_URL}
        />
      </div>
    </div>
  );
};

export default LandingCardSection;

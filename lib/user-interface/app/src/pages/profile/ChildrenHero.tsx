import React from 'react';
import PageHero from '../../components/page/PageHero';

interface ChildrenHeroProps {
  title: string;
  description: string;
  titleId: string;
}

/** My children's hero: the shared PageHero, with the faces illustration. */
const ChildrenHero: React.FC<ChildrenHeroProps> = ({ title, description, titleId }) => (
  <PageHero title={title} description={description} titleId={titleId} showFaces />
);

export default ChildrenHero;

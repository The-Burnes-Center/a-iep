/** The shape of the app's face (Face.tsx): its expressions and its mouth. */

/** The agreement scale's answers, plus the two faces that are not answers. */
export type FaceExpression =
  | 'disagree'
  | 'somewhat_disagree'
  | 'somewhat_agree'
  | 'agree'
  | 'unsure'
  | 'empty';

/** How far the mouth curves, from -1 (frown) to 1 (smile), for each answer. */
export const FACE_MOOD: Record<Exclude<FaceExpression, 'unsure' | 'empty'>, number> = {
  disagree: -0.9,
  somewhat_disagree: -0.4,
  somewhat_agree: 0.4,
  agree: 0.9,
};

/** The mouth for a mood between -1 and 1. Exported for a face that animates between moods. */
export const mouthPath = (mood: number): string => {
  const curve = Math.max(-1, Math.min(1, mood));
  return `M15.5 31.5 Q24 ${31.5 + curve * 8} 32.5 31`;
};

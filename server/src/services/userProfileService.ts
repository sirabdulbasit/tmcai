import prisma from '../db/prisma';

/**
 * UserProfileService — manages user personalization settings.
 * These get injected into the system prompt so the AI adapts to each user.
 */

export interface UserProfile {
  jobDescription: string | null;
  city: string | null;
  contactNumber: string | null;
  aboutMe: string | null;
  instructions: string | null;
  tonePreference: string | null;
  /** How Brain should address the user (e.g. "Sir", "Boss", first name).
   *  Stored under notificationPreferences.profile.preferredTitle to avoid
   *  a schema migration. Joined here so every LLM-context builder sees
   *  one canonical profile shape. */
  preferredTitle: string | null;
}

export async function getUserProfile(userId: number): Promise<UserProfile | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      jobDescription: true,
      city: true,
      contactNumber: true,
      aboutMe: true,
      instructions: true,
      tonePreference: true,
      notificationPreferences: true,
    },
  });

  if (!user) return null;

  const prefs = (user.notificationPreferences as any) ?? {};
  const preferredTitle = prefs?.profile?.preferredTitle ?? null;

  if (
    !user.jobDescription && !user.city && !user.contactNumber
    && !user.aboutMe && !user.instructions && !user.tonePreference
    && !preferredTitle
  ) {
    return null;
  }

  return {
    jobDescription: user.jobDescription,
    city: user.city,
    contactNumber: user.contactNumber,
    aboutMe: user.aboutMe,
    instructions: user.instructions,
    tonePreference: user.tonePreference,
    preferredTitle,
  };
}

export async function updateUserProfile(userId: number, data: Partial<UserProfile>): Promise<UserProfile> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      jobDescription: data.jobDescription !== undefined ? data.jobDescription : undefined,
      city: data.city !== undefined ? data.city : undefined,
      contactNumber: data.contactNumber !== undefined ? data.contactNumber : undefined,
      aboutMe: data.aboutMe !== undefined ? data.aboutMe : undefined,
      instructions: data.instructions !== undefined ? data.instructions : undefined,
      tonePreference: data.tonePreference !== undefined ? data.tonePreference : undefined,
    },
    select: {
      jobDescription: true,
      city: true,
      contactNumber: true,
      aboutMe: true,
      instructions: true,
      tonePreference: true,
      notificationPreferences: true,
    },
  });

  const prefs = (user.notificationPreferences as any) ?? {};
  return {
    jobDescription: user.jobDescription,
    city: user.city,
    contactNumber: user.contactNumber,
    aboutMe: user.aboutMe,
    instructions: user.instructions,
    tonePreference: user.tonePreference,
    preferredTitle: prefs?.profile?.preferredTitle ?? null,
  };
}

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
  /** Grammatical gender Brain uses when referring to / talking about the
   *  user — e.g. "he/him", "she/her", or unspecified. Critical for Urdu
   *  where verbs are gendered ("آپ آئے" m vs "آپ آئیں" f). English uses
   *  it for pronoun selection in third-person ("I'll let him know" vs
   *  "I'll let her know"). Stored under notificationPreferences.profile.
   *  gender alongside preferredTitle to avoid a schema migration.
   *  Default 'female' when unset (per user request 2026-06-10). */
  gender: 'female' | 'male' | 'unspecified' | null;
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
  // Default 'female' so Brain always has a definite grammatical gender
  // (Urdu verbs in particular can't be gender-neutral). Users override
  // via Settings → Profile. Null in DB → 'female' in app.
  const storedGender = prefs?.profile?.gender ?? null;
  const gender: 'female' | 'male' | 'unspecified' = (
    storedGender === 'male' || storedGender === 'female' || storedGender === 'unspecified'
  ) ? storedGender : 'female';

  // Don't gate on profile-presence for gender (it's always 'female' by
  // default, so the "no profile yet" check still needs the other fields
  // to all be empty to return null).
  if (
    !user.jobDescription && !user.city && !user.contactNumber
    && !user.aboutMe && !user.instructions && !user.tonePreference
    && !preferredTitle && !storedGender
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
    gender,
  };
}

export async function updateUserProfile(userId: number, data: Partial<UserProfile>): Promise<UserProfile> {
  // Gender update — merge into notificationPreferences.profile JSON.
  // Skip when caller didn't pass gender at all (preserve current value);
  // accept 'female' | 'male' | 'unspecified' | null (null clears).
  let notifPrefsForUpdate: any = undefined;
  if (data.gender !== undefined) {
    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { notificationPreferences: true },
    });
    const merged: any = current?.notificationPreferences ?? {};
    merged.profile = merged.profile ?? {};
    if (data.gender === null) delete merged.profile.gender;
    else merged.profile.gender = data.gender;
    notifPrefsForUpdate = merged;
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      jobDescription: data.jobDescription !== undefined ? data.jobDescription : undefined,
      city: data.city !== undefined ? data.city : undefined,
      contactNumber: data.contactNumber !== undefined ? data.contactNumber : undefined,
      aboutMe: data.aboutMe !== undefined ? data.aboutMe : undefined,
      instructions: data.instructions !== undefined ? data.instructions : undefined,
      tonePreference: data.tonePreference !== undefined ? data.tonePreference : undefined,
      ...(notifPrefsForUpdate !== undefined ? { notificationPreferences: notifPrefsForUpdate } : {}),
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
  const storedGender = prefs?.profile?.gender ?? null;
  return {
    jobDescription: user.jobDescription,
    city: user.city,
    contactNumber: user.contactNumber,
    aboutMe: user.aboutMe,
    instructions: user.instructions,
    tonePreference: user.tonePreference,
    preferredTitle: prefs?.profile?.preferredTitle ?? null,
    gender: (storedGender === 'male' || storedGender === 'female' || storedGender === 'unspecified')
      ? storedGender : 'female',
  };
}

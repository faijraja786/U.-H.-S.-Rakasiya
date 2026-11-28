# EduFuture — Future Feature Specification

This document is the implementation checklist for the next EduFuture release. Existing authentication, role verification, quizzes, notes, results, leaderboard, daily targets, study routine, flashcards, and server-side answer protection must be preserved.

## Student experience
- Student dashboard: total tests attempted, marks, accuracy, topic-wise progress, rank, and test history.
- Quiz discovery by class, subject, topic, question type, and difficulty.
- Results: objective auto-marking; subjective answers shown as pending until a teacher grades them.
- Doubt solving: students can submit a question with subject/topic and optional attachment URL, track status, and read teacher replies.
- Mobile-first layout and installable PWA experience.

## Teacher experience
- Teacher role assigned only by Admin/Super Admin; never selectable by a public signup.
- Teacher dashboard for assigned classes/subjects, question banks, notes/resources, student submissions, and doubts.
- Teachers can reply to doubts and grade subjective responses for their assigned classes/subjects.
- All teacher actions must be checked server-side against role and assignment.

## Admin experience
- Admin dashboard for users, roles, teachers, students, quizzes, question banks, notes/resources, doubts, and results.
- Admin can assign teachers to classes/subjects and manage published content.
- Super Admin retains exclusive authority to create/remove Admin accounts and manage global settings.

## Quiz builder and question bank
- Quiz metadata: title, class, subject, topic, duration (admin-defined), total marks, publication state.
- Question types: Objective (MCQ) and Subjective (short/long answer).
- Difficulty: Easy, Medium, Hard.
- Question bank can contain up to 1,000 questions per quiz/topic import.
- CSV import and export for bulk questions, with validation and an error report before saving.
- Admin can choose how many questions to draw from each difficulty/type group for a test.
- Objective questions are auto-marked; subjective questions require teacher review.
- Timer is configured by Admin; timed attempts are submitted automatically.
- Large question sets must be written in safe batches/BulkWriter, not a single Firestore batch. Validate request size and Firestore document limits.

## Security and reliability
- Do not expose answer keys to students before release.
- Enforce role permissions on the API, not only in the browser.
- Validate ownership, teacher assignment, question count, file URLs, and attempt deadlines server-side.
- Do not weaken Firestore rules or expose service-account credentials.
- Keep existing free-tier deployment assumptions; do not enable paid billing automatically.

## Mobile/PWA
- Responsive navigation and forms for small screens.
- Web app manifest, icons, service worker, and install prompt where supported.
- Cache only safe static assets; never cache authenticated API responses, private student data, or answer keys.
- Provide an offline fallback page without claiming that quizzes work offline.

## Release checklist
1. Implement and test backend permissions/data model.
2. Implement Student, Teacher, and Admin UI.
3. Implement quiz builder, CSV import/export, and subjective grading.
4. Implement doubts workflow.
5. Implement PWA/mobile layout.
6. Validate build, API health, and role-based flows.
7. Deploy Render backend and then Firebase Hosting; verify the live site.

Do not mark any feature complete until its UI, API, authorization, and basic test path are verified.

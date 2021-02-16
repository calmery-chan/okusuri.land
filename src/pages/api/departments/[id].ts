import { VercelRequest, VercelResponse } from "@vercel/node";
import { DepartmentId } from "~/types/Department";
import { DiseaseId } from "~/types/Disease";
import { verify } from "~/utils/admin/authentication";
import {
  getDepartment,
  getDiseasesByDepartmentId,
  createPrescription,
  getSymptomsByDepartmentId,
  isDepartmentExists,
} from "~/utils/admin/cms";
import { cors } from "~/utils/admin/cors";
import {
  createPatientDisease,
  getPatientDiseases,
  getPatientPhysicalCondition,
  isPatientExists,
  transaction,
  upsertPatientPhysicalCondition,
} from "~/utils/admin/database";

const get = async (request: VercelRequest, response: VercelResponse) => {
  const departmentId = encodeURIComponent(
    request.query.id as string
  ) as DepartmentId;

  if (!(await isDepartmentExists(departmentId))) {
    return response.status(404).end();
  }

  response.send({
    data: await getDepartment(departmentId),
  });
};

const post = async (request: VercelRequest, response: VercelResponse) => {
  /* Firebase で Token を検証、Patient の ID を取得する */

  const patientId = await verify(request);

  if (!patientId || !(await isPatientExists(patientId))) {
    return response.status(403).end();
  }

  /* GraphCMS に指定された Department が存在するか、ユーザからのリクエストが正しいかを確認する */

  const currentSymptoms = (request.body as Partial<{
    symptoms: { [key: string]: number };
  }>)?.symptoms;
  const departmentId = request.query.id as DepartmentId;

  if (!currentSymptoms || !(await isDepartmentExists(departmentId))) {
    return response.status(400).end();
  }

  /* これからの処理に必要となる値を取得、この時点で `departmentId` と `patientId` は正しい値、処理に失敗する場合は何かしら問題が起こっている */

  const diseases = await getDiseasesByDepartmentId(departmentId);
  const physicalCondition = ((
    await getPatientPhysicalCondition(departmentId, patientId)
  )?.json || {}) as Record<string, number>;
  const symptoms = await getSymptomsByDepartmentId(departmentId);

  if (!diseases || !symptoms) {
    return response.status(503).end();
  }

  /* Department に存在する Symptoms を元に PhysicalCondition の値を更新する */

  symptoms.forEach((symptom) => {
    let value = physicalCondition[symptom.key] || symptom.defaultValue;

    if (
      !isNaN(currentSymptoms[symptom.key]) &&
      Math.abs(currentSymptoms[symptom.key]) <= symptom.maximumChange
    ) {
      value += currentSymptoms[symptom.key];
    }

    physicalCondition[symptom.key] = value;
  });

  /* 更新した PhysicalCondition の値をデータベースに反映する */

  await upsertPatientPhysicalCondition(
    departmentId,
    patientId,
    physicalCondition
  );

  /* 更新した PhysicalCondition の値を元に Disease の判定を行う */

  const onsetDiseaseIds: DiseaseId[] = [];
  const patientDiseaseIds = (
    (await getPatientDiseases(patientId, departmentId)) || []
  ).map(({ diseaseId }) => diseaseId);

  diseases.forEach((disease) => {
    // 既に発症している
    if (patientDiseaseIds.includes(disease.id)) {
      return;
    }

    const { symptoms } = disease;

    if (
      // 全ての症状に当てはまる場合、発症している
      symptoms.every(
        (symptom) => symptom.threshold <= physicalCondition[symptom.key]
      )
    ) {
      onsetDiseaseIds.push(disease.id);
    }
  });

  /* 処方箋を作成する */

  const prescription = await createPrescription(onsetDiseaseIds);

  if (!prescription) {
    return response.status(503).end();
  }

  /* データベースに発症した Disease を反映する */

  if (
    !(await transaction(
      onsetDiseaseIds.map((onsetDiseaseId) =>
        createPatientDisease(departmentId, patientId, onsetDiseaseId)
      )
    ))
  ) {
    return response.status(503).end();
  }

  /* */

  response.send({
    data: {
      prescription,
    },
  });
};

// Serverless Functions

export default async (request: VercelRequest, response: VercelResponse) => {
  await cors(request, response);

  switch (request.method) {
    case "GET":
      return get(request, response);

    case "POST":
      return post(request, response);

    default:
      return response.status(405).end();
  }
};

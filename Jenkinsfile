@Library('jenkins-rhapsody-libraries') _ //Importing shared Libraries
import com.rh.rhapsody.*;

rhapsodyUtils.standardPipelineProperties();

def cbi = CortexBuildInfo.getCortexBuildInfo("vexillo", this);

DockerBuildPipeline pipeline = new DockerBuildPipeline(this, cbi, env, "1.0.0");

if (env.BRANCH_NAME?.trim()) {
    pipeline.branch=env.BRANCH_NAME.trim()
}

Map[] envMap = null;
switch (env.BRANCH_NAME) {
  case "develop":
      envMap=[
        ['env': Environment.DEV, 'version': 'default'],
        ['env': Environment.QA, 'version': 'default'],
        ['env': Environment.STAGING, 'version': 'default'],
      ];
    break;
  default:
    envMap=null;
}


pipeline.standardTemplate { label ->
  try {
    node(label) {
      stage ('Init') {
        pipeline.checkoutCode();
      }
      stage('Create Docker images') {
        pipeline.publishAppImage();
      }

      stage('Tagging Config') {
        pipeline.tagConfiguration();
      }
    }
  } catch (Exception e) {
      Notification notification = new Notification(this, cbi, Environment.DEV);
      notification.notifyBuildFailure(env);
      throw e;
  }
}

// This is outside of the node (pod)
if (envMap) {
  envMap.each {
    String version = it.version ?: '';
    stage("promote to ${it.env} ${version}") {
      pipeline.promoteToEnv(pipeline.getImageTag(), it.env, pipeline.branch, version);
    }
  }
} else {
  println("Unknown branch (${env.BRANCH_NAME}), not promoting");
}
